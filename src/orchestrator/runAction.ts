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
import { restoreActivityCache, saveActivityCache } from '../cache/index.js';
import { buildCandidatePool, rankCandidates } from '../engine/index.js';
import { createEmptyOutputs, formatExplanation, writeJobSummary } from '../output.js';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error == null) return undefined;
  const maybeStatus = (error as { status?: unknown }).status;
  if (typeof maybeStatus === 'number') return maybeStatus;
  return undefined;
}

function isTransientAssignmentError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status !== undefined) {
    return status >= 500;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('timed out') || message.includes('econnreset') || message.includes('service unavailable');
}

function isNotAssignableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('not assignable') ||
    message.includes('could not resolve to a user') ||
    message.includes('must be a collaborator')
  );
}

function rankForSelectedAssignee<T extends { login: string }>(ranking: T[], selectedLogin: string): T[] {
  const selected = ranking.find((candidate) => candidate.login === selectedLogin);
  if (!selected) return ranking;
  return [selected, ...ranking.filter((candidate) => candidate.login !== selectedLogin)];
}

function nowMinusDays(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
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
  const resolveCodeowners = codeowners.content
    ? await buildCodeownersResolver(codeowners.content, config.fallbackPatterns)
    : null;

  const teamRefSet = new Set<string>();
  const scopedPathSet = new Set(scopedFiles.map((file) => file.path));
  const ownershipFiles = filesByLoc.map((file) => {
    const ownership = resolveCodeowners
      ? resolveCodeowners(file.path)
      : { directOwners: [], teamRefs: [], fallbackOwners: [], fallbackTeamRefs: [] };
    for (const teamRef of ownership.teamRefs) {
      teamRefSet.add(teamRef);
    }
    for (const teamRef of ownership.fallbackTeamRefs) {
      teamRefSet.add(teamRef);
    }

    return {
      path: file.path,
      loc: scopedPathSet.has(file.path) ? file.loc : 0,
      directOwners: ownership.directOwners,
      teamRefs: ownership.teamRefs,
      fallbackOwners: ownership.fallbackOwners,
      fallbackTeamRefs: ownership.fallbackTeamRefs,
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
    fallbackOwners: [...file.fallbackOwners, ...file.fallbackTeamRefs.flatMap((teamRef) => teamMembersByRef[teamRef] ?? [])],
  }));

  const renameMap = pr.files.some((file) => file.changeType === 'RENAMED')
    ? await fetchRenamePreviousPathByCurrentFilename(octokit, owner, repo, pr.number)
    : {};

  const familiaritySince = nowMinusDays(config.signalWindows.familiarityWindowDays);
  const reviewSince = nowMinusDays(config.signalWindows.reviewWindowDays);
  const activitySince = nowMinusDays(config.signalWindows.activityWindowDays);
  const recentAssignmentSince = nowMinusDays(config.signalWindows.recentAssignmentWindowDays);

  const commitPaths = [...new Set(scopedFiles.flatMap((file) => [file.path, renameMap[file.path]].filter(Boolean) as string[]))];
  const commitSignals = await fetchCommitFamiliaritySignals(
    octokit,
    owner,
    repo,
    pr.defaultBranch,
    familiaritySince,
    commitPaths,
  );
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

  let oooUsers: string[] = [];
  if (config.checkGitHubStatus) {
    try {
      oooUsers = await fetchLimitedAvailabilityUsers(
        octokit,
        preCandidatePool.candidates.map((candidate) => candidate.login),
      );
    } catch (error) {
      core.warning(
        `Status-based availability disabled due to missing read:user or query failure: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      oooUsers = [];
    }
  }
  const restoredActivity = await restoreActivityCache(owner, repo, config.signalWindows.activityWindowDays);
  const activitySignals =
    restoredActivity?.signalsByLogin ??
    (await fetchActivitySignals(
      octokit,
      owner,
      repo,
      activitySince,
      recentAssignmentSince,
      preCandidatePool.candidates.map((candidate) => candidate.login),
      teamMembersByRef,
    ));

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

  if (config.dryRun) {
    outputs.explanation = formatExplanation(ranked.ranking);
    core.info(outputs.explanation);
    await writeJobSummary(ranked.ranking, ranked.assignee, config);
    core.info(`Dry run enabled. Proposed assignee: ${outputs.proposedAssignee}`);
    await saveActivityCache(owner, repo, {
      fetchedAt: new Date().toISOString(),
      activityWindowDays: config.signalWindows.activityWindowDays,
      signalsByLogin: activitySignals,
    });
    return outputs;
  }

  const assignmentAttempts = Math.min(3, ranked.ranking.length);
  for (let attempt = 0; attempt < assignmentAttempts; attempt += 1) {
    const login = ranked.ranking[attempt]?.login;
    if (!login) break;

    let transientRetries = 0;
    while (true) {
      try {
        await octokit.graphql(assignMutation, {
          pullRequestId: pr.nodeId,
          logins: [login],
        });

        outputs.proposedAssignee = login;
        outputs.assignmentPerformed = true;
        const explanationRanking = rankForSelectedAssignee(ranked.ranking, login);
        outputs.explanation = formatExplanation(explanationRanking);
        core.info(outputs.explanation);
        await writeJobSummary(explanationRanking, login, config);
        core.info(`Assigned @${login} to pull request #${pr.number}.`);
        await saveActivityCache(owner, repo, {
          fetchedAt: new Date().toISOString(),
          activityWindowDays: config.signalWindows.activityWindowDays,
          signalsByLogin: activitySignals,
        });
        return outputs;
      } catch (error) {
        if (isTransientAssignmentError(error) && transientRetries < 1) {
          transientRetries += 1;
          core.warning(
            `Transient assignment error for @${login}; retrying once in 2s. ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          await sleep(2000);
          continue;
        }

        if (isNotAssignableError(error)) {
          core.warning(
            `Candidate @${login} is not assignable; trying next candidate. ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          break;
        }

        core.warning(
          `Assignment failed for @${login}; aborting fallback to preserve deterministic winner. ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        outputs.assignmentPerformed = false;
        await saveActivityCache(owner, repo, {
          fetchedAt: new Date().toISOString(),
          activityWindowDays: config.signalWindows.activityWindowDays,
          signalsByLogin: activitySignals,
        });
        return outputs;
      }
    }
  }

  outputs.assignmentPerformed = false;
  core.warning('All assignment attempts failed. Proceeding without assignee.');
  await saveActivityCache(owner, repo, {
    fetchedAt: new Date().toISOString(),
    activityWindowDays: config.signalWindows.activityWindowDays,
    signalsByLogin: activitySignals,
  });
  return outputs;

}
