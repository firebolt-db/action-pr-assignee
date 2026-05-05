import { describe, expect, it } from 'bun:test';
import type { OctokitLike, PrCoreData } from '../../src/adapters/github/types.js';
import { runAction } from '../../src/orchestrator/runAction.js';

function makeInputs(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    github_token: 'ghs_primary',
    token_override: '',
    dry_run: 'true',
    opt_out_label: 'no-auto-assign',
    familiarity_window_days: '30',
    review_window_days: '30',
    recent_assignment_window_days: '10',
    activity_window_days: '30',
    check_github_status: 'true',
    exclude_users: '',
    bot_login_patterns: '\\[bot\\]$\n^dependabot$\n^renovate$',
    fallback_patterns: '^\\*$\n^/$',
    unavailable_reviewers: '',
    weight_direct_gte50: '50',
    weight_direct_gte20: '35',
    weight_direct_floor: '20',
    weight_team_any: '20',
    weight_fallback_any: '5',
    weight_code_familiarity_per_commit: '5',
    weight_code_familiarity_max: '25',
    weight_review_familiarity_per_review: '4',
    weight_review_familiarity_max: '20',
    weight_active_load_per_pr: '8',
    weight_active_load_max: '24',
    weight_pending_review_per_request: '5',
    weight_pending_review_max: '20',
    weight_recent_assignment_per_pr: '6',
    weight_recent_assignment_max: '18',
    weight_team_fallback_penalty: '10',
    weight_fallback_only_penalty: '20',
    ...overrides,
  };
}

function makeCore(inputOverrides: Record<string, string> = {}) {
  const rawInputs = makeInputs(inputOverrides);
  const warnings: string[] = [];
  const infos: string[] = [];

  const core = {
    getInput(name: string, options?: { required?: boolean }): string {
      const value = rawInputs[name] ?? '';
      if (options?.required && value.trim().length === 0) {
        throw new Error(`Input required and not supplied: ${name}`);
      }
      return value;
    },
    getBooleanInput(name: string): boolean {
      const raw = this.getInput(name).toLowerCase();
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new Error(`Boolean input expected for ${name}, got "${raw}"`);
    },
    debug(_message: string): void {},
    info(message: string): void {
      infos.push(message);
    },
    warning(message: string | Error): void {
      warnings.push(message instanceof Error ? message.message : message);
    },
  };

  return { core, warnings, infos };
}

function makePrCore(overrides: Partial<PrCoreData> = {}): PrCoreData {
  return {
    nodeId: 'PR_node_1',
    number: 10,
    isDraft: false,
    authorLogin: 'author',
    assignees: [],
    labels: [],
    requestedReviewers: [],
    baseOwner: 'firebolt',
    baseRepo: 'repo',
    baseRef: 'main',
    defaultBranch: 'main',
    headOwner: 'firebolt',
    headRepo: 'repo',
    files: [{ path: 'src/a.ts', additions: 10, deletions: 0, changeType: 'MODIFIED' }],
    suggestedReviewers: ['alice'],
    ...overrides,
  };
}

function makeOctokit(
  assignBehavior: 'success' | 'not_assignable' | 'fatal',
  unresolvableLogins: ReadonlySet<string> = new Set(),
): OctokitLike {
  return {
    graphql: async (query: string, variables?: Record<string, unknown>) => {
      if (variables?.pullRequestId) {
        if (assignBehavior === 'success') {
          return {};
        }
        if (assignBehavior === 'not_assignable') {
          throw new Error('User is not assignable');
        }
        throw new Error('fatal assignment error');
      }
      if (query.includes('ResolveUserId')) {
        const login = variables?.login as string | undefined;
        if (login && unresolvableLogins.has(login)) {
          return { user: null };
        }
        return { user: { id: `USER_${login ?? 'unknown'}` } };
      }
      return {};
    },
    rest: {
      pulls: {
        listFiles: async () => ({ data: [] }),
      },
    },
  };
}

describe('runAction integration with injected deps', () => {
  it('warns when CODEOWNERS missing and signal fallback is used', async () => {
    const { core, warnings } = makeCore({ dry_run: 'true' });

    const result = await runAction({
      core,
      githubContext: {
        repo: { owner: 'firebolt', repo: 'repo' },
        payload: { pull_request: { number: 10 } },
      } as typeof import('@actions/github').context,
      getOctokit: () => makeOctokit('success'),
      adapters: {
        fetchPrCoreData: async () => makePrCore(),
        fetchCodeownersAtBaseRef: async () => ({ found: false, path: null, content: null }),
        fetchRenamePreviousPathByCurrentFilename: async () => ({}),
        expandTeamMembers: async () => [],
        fetchCommitFamiliaritySignals: async () => ({ alice: 2 }),
        fetchReviewFamiliaritySignals: async () => ({}),
        fetchDeletedUsers: async () => [],
        fetchLimitedAvailabilityUsers: async () => [],
        fetchActivitySignals: async () => ({}),
      },
      cache: {
        restoreActivityCache: async () => null,
        saveActivityCache: async () => {},
      },
      buildCodeownersResolver: async () => () => ({
        directOwners: [],
        teamRefs: [],
        fallbackOwners: [],
        fallbackTeamRefs: [],
      }),
      writeJobSummary: async () => {},
      sleep: async () => {},
    });

    expect(result.proposedAssignee).toBe('alice');
    expect(warnings.some((warning) => warning.includes('CODEOWNERS not found'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('seeded'))).toBe(true);
  });

  it('degrades gracefully when commit familiarity fetch fails', async () => {
    const { core, warnings } = makeCore({ dry_run: 'true' });

    const result = await runAction({
      core,
      githubContext: {
        repo: { owner: 'firebolt', repo: 'repo' },
        payload: { pull_request: { number: 10 } },
      } as typeof import('@actions/github').context,
      getOctokit: () => makeOctokit('success'),
      adapters: {
        fetchPrCoreData: async () => makePrCore(),
        fetchCodeownersAtBaseRef: async () => ({ found: true, path: 'CODEOWNERS', content: 'src/** @alice' }),
        fetchRenamePreviousPathByCurrentFilename: async () => ({}),
        expandTeamMembers: async () => [],
        fetchCommitFamiliaritySignals: async () => {
          throw new Error('graphql unavailable');
        },
        fetchReviewFamiliaritySignals: async () => ({}),
        fetchDeletedUsers: async () => [],
        fetchLimitedAvailabilityUsers: async () => [],
        fetchActivitySignals: async () => ({}),
      },
      cache: {
        restoreActivityCache: async () => null,
        saveActivityCache: async () => {},
      },
      buildCodeownersResolver: async () => () => ({
        directOwners: ['alice'],
        teamRefs: [],
        fallbackOwners: [],
        fallbackTeamRefs: [],
      }),
      writeJobSummary: async () => {},
      sleep: async () => {},
    });

    expect(result.proposedAssignee).toBe('alice');
    expect(warnings.some((warning) => warning.includes('Commit familiarity signal unavailable'))).toBe(true);
  });

  it('does not save cache when assignment fails before success', async () => {
    const { core } = makeCore({ dry_run: 'false' });
    let saveCalls = 0;

    const result = await runAction({
      core,
      githubContext: {
        repo: { owner: 'firebolt', repo: 'repo' },
        payload: { pull_request: { number: 10 } },
      } as typeof import('@actions/github').context,
      getOctokit: () => makeOctokit('fatal'),
      adapters: {
        fetchPrCoreData: async () => makePrCore(),
        fetchCodeownersAtBaseRef: async () => ({ found: true, path: 'CODEOWNERS', content: 'src/** @alice' }),
        fetchRenamePreviousPathByCurrentFilename: async () => ({}),
        expandTeamMembers: async () => [],
        fetchCommitFamiliaritySignals: async () => ({ alice: 1 }),
        fetchReviewFamiliaritySignals: async () => ({}),
        fetchDeletedUsers: async () => [],
        fetchLimitedAvailabilityUsers: async () => [],
        fetchActivitySignals: async () => ({}),
      },
      cache: {
        restoreActivityCache: async () => null,
        saveActivityCache: async () => {
          saveCalls += 1;
        },
      },
      buildCodeownersResolver: async () => () => ({
        directOwners: ['alice'],
        teamRefs: [],
        fallbackOwners: [],
        fallbackTeamRefs: [],
      }),
      writeJobSummary: async () => {},
      sleep: async () => {},
    });

    expect(result.assignmentPerformed).toBe(false);
    expect(saveCalls).toBe(0);
  });

  it('falls through to next candidate when top winner cannot be resolved to a user', async () => {
    const { core, warnings, infos } = makeCore({ dry_run: 'false' });

    const result = await runAction({
      core,
      githubContext: {
        repo: { owner: 'firebolt', repo: 'repo' },
        payload: { pull_request: { number: 10 } },
      } as typeof import('@actions/github').context,
      getOctokit: () => makeOctokit('success', new Set(['cursor'])),
      adapters: {
        fetchPrCoreData: async () => makePrCore({ suggestedReviewers: ['cursor', 'alice'] }),
        fetchCodeownersAtBaseRef: async () => ({
          found: true,
          path: 'CODEOWNERS',
          content: 'src/** @cursor @alice',
        }),
        fetchRenamePreviousPathByCurrentFilename: async () => ({}),
        expandTeamMembers: async () => [],
        fetchCommitFamiliaritySignals: async () => ({ cursor: 5, alice: 1 }),
        fetchReviewFamiliaritySignals: async () => ({}),
        fetchDeletedUsers: async () => [],
        fetchLimitedAvailabilityUsers: async () => [],
        fetchActivitySignals: async () => ({}),
      },
      cache: {
        restoreActivityCache: async () => null,
        saveActivityCache: async () => {},
      },
      buildCodeownersResolver: async () => () => ({
        directOwners: ['cursor', 'alice'],
        teamRefs: [],
        fallbackOwners: [],
        fallbackTeamRefs: [],
      }),
      writeJobSummary: async () => {},
      sleep: async () => {},
    });

    expect(result.assignmentPerformed).toBe(true);
    expect(result.proposedAssignee).toBe('alice');
    expect(
      warnings.some((warning) => warning.includes('@cursor could not be resolved to a user')),
    ).toBe(true);
    expect(infos.some((info) => info.includes('Assigned @alice'))).toBe(true);
  });
});
