import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  expandTeamMembers,
  fetchActivitySignals,
  fetchCodeownersAtBaseRef,
  fetchCommitFamiliaritySignals,
  fetchDeletedUsers,
  fetchLimitedAvailabilityUsers,
  fetchPrCoreData,
  fetchRenamePreviousPathByCurrentFilename,
  fetchReviewFamiliaritySignals,
  type OctokitLike,
} from '../adapters/github/index.js';
import { parseActionConfig } from '../config/parseConfig.js';
import { restoreActivityCache, saveActivityCache } from '../cache/index.js';
import {
  buildCandidatePool,
  rankCandidates,
  type BuildCandidatePoolResult,
  type Candidate,
  type RankCandidatesResult,
} from '../engine/index.js';
import { createEmptyOutputs, formatExplanation, writeJobSummary } from '../output.js';
import type { ActionRunResult } from '../types.js';
import { buildCodeownersResolver } from './codeowners.js';

const assignMutation = `
  mutation AssignPr($pullRequestId: ID!, $assigneeIds: [ID!]!) {
    addAssigneesToAssignable(input: { assignableId: $pullRequestId, assigneeIds: $assigneeIds }) {
      assignable {
        ... on PullRequest {
          id
        }
      }
    }
  }
`;

const resolveUserIdQuery = `
  query ResolveUserId($login: String!) {
    user(login: $login) {
      id
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

interface RunActionDeps {
  core: {
    getInput: (name: string, options?: { required?: boolean }) => string;
    getBooleanInput: (name: string) => boolean;
    debug: (message: string) => void;
    info: (message: string) => void;
    warning: (message: string | Error) => void;
  };
  githubContext: typeof github.context;
  getOctokit: (token: string) => OctokitLike;
  adapters: {
    fetchPrCoreData: typeof fetchPrCoreData;
    fetchCodeownersAtBaseRef: typeof fetchCodeownersAtBaseRef;
    fetchRenamePreviousPathByCurrentFilename: typeof fetchRenamePreviousPathByCurrentFilename;
    expandTeamMembers: typeof expandTeamMembers;
    fetchCommitFamiliaritySignals: typeof fetchCommitFamiliaritySignals;
    fetchReviewFamiliaritySignals: typeof fetchReviewFamiliaritySignals;
    fetchDeletedUsers: typeof fetchDeletedUsers;
    fetchLimitedAvailabilityUsers: typeof fetchLimitedAvailabilityUsers;
    fetchActivitySignals: typeof fetchActivitySignals;
  };
  cache: {
    restoreActivityCache: typeof restoreActivityCache;
    saveActivityCache: typeof saveActivityCache;
  };
  buildCodeownersResolver: typeof buildCodeownersResolver;
  rankCandidates: typeof rankCandidates;
  buildCandidatePool: typeof buildCandidatePool;
  writeJobSummary: typeof writeJobSummary;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: RunActionDeps = {
  core,
  githubContext: github.context,
  getOctokit: (token) => github.getOctokit(token) as unknown as OctokitLike,
  adapters: {
    fetchPrCoreData,
    fetchCodeownersAtBaseRef,
    fetchRenamePreviousPathByCurrentFilename,
    expandTeamMembers,
    fetchCommitFamiliaritySignals,
    fetchReviewFamiliaritySignals,
    fetchDeletedUsers,
    fetchLimitedAvailabilityUsers,
    fetchActivitySignals,
  },
  cache: {
    restoreActivityCache,
    saveActivityCache,
  },
  buildCodeownersResolver,
  rankCandidates,
  buildCandidatePool,
  writeJobSummary,
  sleep,
};

export async function runAction(partialDeps: Partial<RunActionDeps> = {}): Promise<ActionRunResult> {
  const deps: RunActionDeps = {
    ...defaultDeps,
    ...partialDeps,
    adapters: {
      ...defaultDeps.adapters,
      ...(partialDeps.adapters ?? {}),
    },
    cache: {
      ...defaultDeps.cache,
      ...(partialDeps.cache ?? {}),
    },
  };

  const outputs = createEmptyOutputs();
  const config = parseActionConfig(deps.core);
  const baseOctokit = deps.getOctokit(config.githubToken);
  const scopedOverrideOctokit = config.tokenOverride ? deps.getOctokit(config.tokenOverride) : null;
  const elevatedOctokit = scopedOverrideOctokit ?? baseOctokit;

  const owner = deps.githubContext.repo.owner;
  const repo = deps.githubContext.repo.repo;
  const pullNumber = deps.githubContext.payload.pull_request?.number;
  if (!owner || !repo || typeof pullNumber !== 'number') {
    throw new Error('Malformed event payload: missing repository owner/name or pull request number.');
  }

  let pr: Awaited<ReturnType<typeof fetchPrCoreData>>;
  try {
    pr = await deps.adapters.fetchPrCoreData(baseOctokit, owner, repo, pullNumber);
  } catch (error) {
    deps.core.warning(
      `Unable to fetch PR core data, skipping assignment: ${error instanceof Error ? error.message : String(error)}`,
    );
    return outputs;
  }

  if (pr.isDraft) {
    outputs.skippedReason = 'draft';
    deps.core.info('Skipping assignment: pull request is draft.');
    return outputs;
  }

  if (pr.assignees.length > 0) {
    outputs.skippedReason = 'already_assigned';
    deps.core.info('Skipping assignment: pull request already has assignees.');
    return outputs;
  }

  if (config.optOutLabel && pr.labels.includes(config.optOutLabel)) {
    outputs.skippedReason = 'opted_out';
    deps.core.info(`Skipping assignment: opt-out label "${config.optOutLabel}" is present.`);
    return outputs;
  }

  if (pr.baseOwner !== pr.headOwner || pr.baseRepo !== pr.headRepo) {
    outputs.skippedReason = 'fork_pr';
    deps.core.info('Skipping assignment: pull request originates from a fork.');
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
    deps.core.warning(`PR touches ${pr.files.length} files; familiarity and ownership computed on top 200 by LOC.`);
  }

  const codeowners = await (async () => {
    try {
      return await deps.adapters.fetchCodeownersAtBaseRef(baseOctokit, owner, repo, pr.baseRef);
    } catch (error) {
      deps.core.warning(
        `Unable to fetch CODEOWNERS at base ref, continuing without ownership signal: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { found: false, path: null, content: null } as const;
    }
  })();
  if (!codeowners.found) {
    deps.core.warning('CODEOWNERS not found; seeding candidates from familiarity and suggested reviewers.');
  }
  const resolveCodeowners = codeowners.content
    ? await (async () => {
        try {
          return await deps.buildCodeownersResolver(codeowners.content!, config.fallbackPatterns);
        } catch (error) {
          deps.core.warning(
            `Unable to parse CODEOWNERS content, continuing without ownership signal: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return null;
        }
      })()
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
      teamMembersByRef[teamRef] = await deps.adapters.expandTeamMembers(elevatedOctokit, org, slug);
    } catch (error) {
      deps.core.warning(
        `Team expansion failed for @${teamRef}: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    ? await (async () => {
        try {
          return await deps.adapters.fetchRenamePreviousPathByCurrentFilename(baseOctokit, owner, repo, pr.number);
        } catch (error) {
          deps.core.warning(
            `Rename recovery unavailable, continuing without previous paths: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return {};
        }
      })()
    : {};

  const familiaritySince = nowMinusDays(config.signalWindows.familiarityWindowDays);
  const reviewSince = nowMinusDays(config.signalWindows.reviewWindowDays);
  const activitySince = nowMinusDays(config.signalWindows.activityWindowDays);
  const recentAssignmentSince = nowMinusDays(config.signalWindows.recentAssignmentWindowDays);

  const commitPaths = [...new Set(scopedFiles.flatMap((file) => [file.path, renameMap[file.path]].filter(Boolean) as string[]))];
  const commitSignals = await (async () => {
    try {
      return await deps.adapters.fetchCommitFamiliaritySignals(
        baseOctokit,
        owner,
        repo,
        pr.defaultBranch,
        familiaritySince,
        commitPaths,
      );
    } catch (error) {
      deps.core.warning(
        `Commit familiarity signal unavailable, continuing without it: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {} as Record<string, number>;
    }
  })();
  const reviewSignals = await (async () => {
    try {
      return await deps.adapters.fetchReviewFamiliaritySignals(
        baseOctokit,
        owner,
        repo,
        reviewSince,
        scopedFiles.map((file) => file.path),
      );
    } catch (error) {
      deps.core.warning(
        `Review familiarity signal unavailable, continuing without it: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {} as Record<string, number>;
    }
  })();

  const preCandidatePool: BuildCandidatePoolResult = deps.buildCandidatePool({
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

  let deletedUsers: string[] = [];
  try {
    deletedUsers = await deps.adapters.fetchDeletedUsers(
      baseOctokit,
      preCandidatePool.candidates.map((candidate) => candidate.login),
    );
  } catch (error) {
    deps.core.warning(
      `Deleted-user filter unavailable, continuing without it: ${error instanceof Error ? error.message : String(error)}`,
    );
    deletedUsers = [];
  }

  let oooUsers: string[] = [];
  if (config.checkGitHubStatus) {
    try {
      oooUsers = await deps.adapters.fetchLimitedAvailabilityUsers(
        elevatedOctokit,
        preCandidatePool.candidates.map((candidate) => candidate.login),
      );
    } catch (error) {
      deps.core.warning(
        `Status-based availability disabled due to missing read:user or query failure: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      oooUsers = [];
    }
  }
  const restoredActivity = await deps.cache.restoreActivityCache(
    owner,
    repo,
    config.signalWindows.activityWindowDays,
  );
  const activitySignals =
    restoredActivity?.signalsByLogin ??
    (await (async () => {
      try {
        return await deps.adapters.fetchActivitySignals(
          elevatedOctokit,
          owner,
          repo,
          activitySince,
          recentAssignmentSince,
          teamMembersByRef,
        );
      } catch (error) {
        deps.core.warning(
          `Activity/workload signal unavailable, continuing without it: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return {};
      }
    })());

  const candidatePool: BuildCandidatePoolResult = deps.buildCandidatePool({
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
      deletedUsers,
    },
  });

  if (candidatePool.candidates.length === 0) {
    outputs.skippedReason = 'empty_candidate_pool';
    deps.core.warning('No candidates remain after applying candidate filters.');
    return outputs;
  }
  if (candidatePool.usedSignalFallback) {
    deps.core.warning(
      codeowners.found
        ? 'CODEOWNERS candidates were filtered out; seeding candidate pool from familiarity signals.'
        : 'Candidate pool seeded from familiarity/suggested reviewer signals because CODEOWNERS is unavailable.',
    );
  }

  let ranked: RankCandidatesResult;
  try {
    ranked = deps.rankCandidates({
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
    deps.core.warning(error instanceof Error ? error.message : String(error));
    return outputs;
  }

  outputs.rankedCandidatesJson = JSON.stringify(ranked.ranking);
  outputs.proposedAssignee = ranked.assignee;

  if (config.dryRun) {
    outputs.explanation = formatExplanation(ranked.ranking);
    deps.core.info(outputs.explanation);
    await deps.writeJobSummary(ranked.ranking, ranked.assignee, config);
    deps.core.info(`Dry run enabled. Proposed assignee: ${outputs.proposedAssignee}`);
    await deps.cache.saveActivityCache(owner, repo, {
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
        if ((ranked.ranking[attempt]?.total ?? 0) <= 0) {
          break;
        }

        const resolved = (await baseOctokit.graphql(resolveUserIdQuery, {
          login,
        })) as { user: { id: string } | null };

        if (!resolved.user?.id) {
          deps.core.warning(
            `Candidate @${login} could not be resolved to a user; trying next candidate.`,
          );
          break;
        }

        await baseOctokit.graphql(assignMutation, {
          pullRequestId: pr.nodeId,
          assigneeIds: [resolved.user.id],
        });

        outputs.proposedAssignee = login;
        outputs.assignmentPerformed = true;
        const explanationRanking = rankForSelectedAssignee(ranked.ranking, login);
        outputs.explanation = formatExplanation(explanationRanking);
        deps.core.info(outputs.explanation);
        await deps.writeJobSummary(explanationRanking, login, config);
        deps.core.info(`Assigned @${login} to pull request #${pr.number}.`);
        await deps.cache.saveActivityCache(owner, repo, {
          fetchedAt: new Date().toISOString(),
          activityWindowDays: config.signalWindows.activityWindowDays,
          signalsByLogin: activitySignals,
        });
        return outputs;
      } catch (error) {
        if (isTransientAssignmentError(error) && transientRetries < 1) {
          transientRetries += 1;
          deps.core.warning(
            `Transient assignment error for @${login}; retrying once in 2s. ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          await deps.sleep(2000);
          continue;
        }

        if (isNotAssignableError(error)) {
          deps.core.warning(
            `Candidate @${login} is not assignable; trying next candidate. ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          break;
        }

        deps.core.warning(
          `Assignment failed for @${login}; aborting fallback to preserve deterministic winner. ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        outputs.assignmentPerformed = false;
        return outputs;
      }
    }
  }

  outputs.assignmentPerformed = false;
  deps.core.warning('All assignment attempts failed. Proceeding without assignee.');
  return outputs;

}
