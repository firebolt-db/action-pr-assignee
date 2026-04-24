import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  expandTeamMembers,
  fetchActivitySignals,
  fetchCodeownersAtBaseRef,
  fetchCommitFamiliaritySignals,
  fetchLimitedAvailabilityUsers,
  fetchPrCoreData,
  fetchRenamePreviousPathByCurrentFilename,
  fetchReviewFamiliaritySignals,
  type OctokitLike,
} from '../adapters/github/index.js';
import { parseActionConfig } from '../config/parseConfig.js';
import { buildCandidatePool, rankCandidates } from '../engine/index.js';
import { createEmptyOutputs } from '../output.js';
import type { ActionRunResult } from '../types.js';
import { buildCodeownersResolver } from './codeowners.js';

const assignMutation = `
  mutation AssignPr($pullRequestId: ID!, $logins: [String!]!) {
    addAssigneesToAssignable(input: { assignableId: $pullRequestId, assigneeLogins: $logins }) {
      assignable {
        ... on PullRequest {
          id
        }
      }
    }
  }
`;

function nowMinusDays(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

function buildExplanation(assignee: string, total: number, runnerUp: { login: string; total: number } | null): string {
  if (!runnerUp) {
    return `${assignee} - total ${total}`;
  }
  return `${assignee} - total ${total}; runner-up: ${runnerUp.login} (${runnerUp.total})`;
}

export async function runAction(): Promise<ActionRunResult> {
  const outputs = createEmptyOutputs();
  const config = parseActionConfig(core);
  const octokit = github.getOctokit(config.effectiveToken) as unknown as OctokitLike;

  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;
  const pullNumber = github.context.payload.pull_request?.number;
  if (!owner || !repo || typeof pullNumber !== 'number') {
    throw new Error('Malformed event payload: missing repository owner/name or pull request number.');
  }

  const pr = await fetchPrCoreData(octokit, owner, repo, pullNumber);

  if (pr.isDraft) {
    outputs.skippedReason = 'draft';
    core.info('Skipping assignment: pull request is draft.');
    return outputs;
  }

  if (pr.assignees.length > 0) {
    outputs.skippedReason = 'already_assigned';
    core.info('Skipping assignment: pull request already has assignees.');
    return outputs;
  }

  if (config.optOutLabel && pr.labels.includes(config.optOutLabel)) {
    outputs.skippedReason = 'opted_out';
    core.info(`Skipping assignment: opt-out label "${config.optOutLabel}" is present.`);
    return outputs;
  }

  if (pr.baseOwner !== pr.headOwner || pr.baseRepo !== pr.headRepo) {
    outputs.skippedReason = 'fork_pr';
    core.info('Skipping assignment: pull request originates from a fork.');
    return outputs;
  }

  const filesByLoc = [...pr.files]
    .map((file) => ({
      ...file,
      loc: file.additions + file.deletions,
    }))
    .sort((a, b) => b.loc - a.loc);
  const scopedFiles = filesByLoc.slice(0, 200);
  if (pr.files.length > 200) {
    core.warning(`PR touches ${pr.files.length} files; familiarity and ownership computed on top 200 by LOC.`);
  }

  const codeowners = await fetchCodeownersAtBaseRef(octokit, owner, repo, pr.baseRef);
  const resolveCodeowners = codeowners.content ? await buildCodeownersResolver(codeowners.content) : null;

  const teamRefSet = new Set<string>();
  const ownershipFiles = scopedFiles.map((file) => {
    const ownership = resolveCodeowners ? resolveCodeowners(file.path) : { directOwners: [], teamRefs: [] };
    for (const teamRef of ownership.teamRefs) {
      teamRefSet.add(teamRef);
    }

    return {
      path: file.path,
      loc: file.loc,
      directOwners: ownership.directOwners,
      teamRefs: ownership.teamRefs,
    };
  });

  const teamMembersByRef: Record<string, string[]> = {};
  for (const teamRef of [...teamRefSet]) {
    const [org, slug] = teamRef.split('/');
    if (!org || !slug) continue;
    try {
      teamMembersByRef[teamRef] = await expandTeamMembers(octokit, org, slug);
    } catch (error) {
      core.warning(`Team expansion failed for @${teamRef}: ${error instanceof Error ? error.message : String(error)}`);
      teamMembersByRef[teamRef] = [];
    }
  }

  const candidateFiles = ownershipFiles.map((file) => ({
    path: file.path,
    loc: file.loc,
    directOwners: file.directOwners,
    teamMembers: file.teamRefs.flatMap((teamRef) => teamMembersByRef[teamRef] ?? []),
    fallbackOwners: [],
  }));

  const renameMap = pr.files.some((file) => file.changeType === 'RENAMED')
    ? await fetchRenamePreviousPathByCurrentFilename(octokit, owner, repo, pr.number)
    : {};

  const familiaritySince = nowMinusDays(config.signalWindows.familiarityWindowDays);
  const reviewSince = nowMinusDays(config.signalWindows.reviewWindowDays);
  const activitySince = nowMinusDays(config.signalWindows.activityWindowDays);
  const recentAssignmentSince = nowMinusDays(config.signalWindows.recentAssignmentWindowDays);

  const commitPaths = [...new Set(scopedFiles.flatMap((file) => [file.path, renameMap[file.path]].filter(Boolean) as string[]))];
  const commitSignals = await fetchCommitFamiliaritySignals(octokit, owner, repo, pr.baseRef, familiaritySince, commitPaths);
  const reviewSignals = await fetchReviewFamiliaritySignals(
    octokit,
    owner,
    repo,
    reviewSince,
    scopedFiles.map((file) => file.path),
  );

  const preCandidatePool = buildCandidatePool({
    codeownersPresent: codeowners.found,
    files: candidateFiles,
    signalSeeds: {
      commitFamiliarityLogins: Object.keys(commitSignals),
      reviewFamiliarityLogins: Object.keys(reviewSignals),
      suggestedReviewerLogins: pr.suggestedReviewers,
    },
    filters: {
      prAuthor: pr.authorLogin ?? '',
      excludeUsers: config.excludeUsers,
      unavailableReviewers: config.unavailableReviewers,
      botLoginPatterns: config.botLoginPatterns,
      oooUsers: [],
      deletedUsers: [],
    },
  });

  const oooUsers = config.checkGitHubStatus
    ? await fetchLimitedAvailabilityUsers(
        octokit,
        preCandidatePool.candidates.map((candidate) => candidate.login),
      )
    : [];
  const activitySignals = await fetchActivitySignals(
    octokit,
    owner,
    repo,
    activitySince,
    recentAssignmentSince,
    preCandidatePool.candidates.map((candidate) => candidate.login),
    teamMembersByRef,
  );

  const candidatePool = buildCandidatePool({
    codeownersPresent: codeowners.found,
    files: candidateFiles,
    signalSeeds: {
      commitFamiliarityLogins: Object.keys(commitSignals),
      reviewFamiliarityLogins: Object.keys(reviewSignals),
      suggestedReviewerLogins: pr.suggestedReviewers,
    },
    filters: {
      prAuthor: pr.authorLogin ?? '',
      excludeUsers: config.excludeUsers,
      unavailableReviewers: config.unavailableReviewers,
      botLoginPatterns: config.botLoginPatterns,
      oooUsers,
      deletedUsers: [],
    },
  });

  if (candidatePool.candidates.length === 0) {
    outputs.skippedReason = 'empty_candidate_pool';
    core.warning('No candidates remain after applying candidate filters.');
    return outputs;
  }

  let ranked;
  try {
    ranked = rankCandidates({
      candidates: candidatePool.candidates,
      weights: config.scoreWeights,
      signalsByLogin: Object.fromEntries(
        candidatePool.candidates.map((candidate) => [
          candidate.login,
          {
            commitCount: commitSignals[candidate.login] ?? 0,
            reviewCount: reviewSignals[candidate.login] ?? 0,
            openAssignedPrs: activitySignals[candidate.login]?.activity.openAssignedPrs ?? 0,
            pendingReviewRequests: activitySignals[candidate.login]?.activity.pendingReviewRequests ?? 0,
            recentAssignments: activitySignals[candidate.login]?.activity.recentAssignments ?? 0,
          },
        ]),
      ),
    });
  } catch (error) {
    outputs.skippedReason = 'empty_candidate_pool';
    core.warning(error instanceof Error ? error.message : String(error));
    return outputs;
  }

  outputs.rankedCandidatesJson = JSON.stringify(ranked.ranking);
  outputs.proposedAssignee = ranked.assignee;
  outputs.explanation = buildExplanation(
    ranked.assignee,
    ranked.ranking[0]?.total ?? 0,
    ranked.ranking[1] ? { login: ranked.ranking[1].login, total: ranked.ranking[1].total } : null,
  );

  if (config.dryRun) {
    core.info(`Dry run enabled. Proposed assignee: ${outputs.proposedAssignee}`);
    return outputs;
  }

  const assignmentAttempts = Math.min(3, ranked.ranking.length);
  for (let attempt = 0; attempt < assignmentAttempts; attempt += 1) {
    const login = ranked.ranking[attempt]?.login;
    if (!login) break;

    try {
      await octokit.graphql(assignMutation, {
        pullRequestId: pr.nodeId,
        logins: [login],
      });

      outputs.proposedAssignee = login;
      outputs.assignmentPerformed = true;
      core.info(`Assigned @${login} to pull request #${pr.number}.`);
      return outputs;
    } catch (error) {
      core.warning(
        `Assignment attempt failed for @${login}; trying next candidate. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  outputs.assignmentPerformed = false;
  core.warning('All assignment attempts failed. Proceeding without assignee.');
  return outputs;

}
