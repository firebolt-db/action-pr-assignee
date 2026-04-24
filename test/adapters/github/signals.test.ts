import { describe, expect, it } from 'bun:test';
import {
  expandTeamMembers,
  fetchActivitySignals,
  fetchCommitFamiliaritySignals,
  fetchDeletedUsers,
  fetchLimitedAvailabilityUsers,
  fetchReviewFamiliaritySignals,
} from '../../../src/adapters/github/signals.js';
import type { OctokitLike } from '../../../src/adapters/github/types.js';

describe('github signal adapters', () => {
  it('projects activity counters', async () => {
    const octokit = {
      graphql: async () => ({
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                updatedAt: '2026-04-01T00:00:00Z',
                assignees: { nodes: [{ login: 'Alice' }] },
                reviewRequests: {
                  nodes: [
                    { requestedReviewer: { login: 'Bob' } },
                    { requestedReviewer: { slug: 'core', organization: { login: 'org' } } },
                  ],
                },
                timelineItems: {
                  nodes: [
                    {
                      createdAt: '2026-04-02T00:00:00Z',
                      assignee: { login: 'Alice' },
                    },
                    {
                      createdAt: '2026-04-03T00:00:00Z',
                      assignee: { login: 'Alice' },
                    },
                  ],
                },
              },
            ],
          },
        },
      }),
      rest: {
        pulls: {
          listFiles: async () => ({ data: [] }),
        },
      },
    } as OctokitLike;

    const result = await fetchActivitySignals(
      octokit,
      'o',
      'r',
      '2026-03-01T00:00:00Z',
      '2026-03-01T00:00:00Z',
      { 'org/core': ['alice'] },
    );

    expect(result.alice?.activity.openAssignedPrs).toBe(1);
    expect(result.alice?.activity.recentAssignments).toBe(1);
    expect(result.bob?.activity.pendingReviewRequests).toBe(1);
    expect(result.alice?.activity.pendingReviewRequests).toBe(1);
  });

  it('counts distinct overlapping review familiarity', async () => {
    const octokit = {
      graphql: async () => ({
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                updatedAt: '2026-04-05T00:00:00Z',
                files: { nodes: [{ path: 'src/a.ts' }] },
                reviews: {
                  nodes: [
                    { author: { login: 'Alice' }, submittedAt: '2026-04-04T00:00:00Z' },
                    { author: { login: 'Alice' }, submittedAt: '2026-04-03T00:00:00Z' },
                  ],
                },
              },
            ],
          },
        },
      }),
      rest: {
        pulls: {
          listFiles: async () => ({ data: [] }),
        },
      },
    } as OctokitLike;

    const result = await fetchReviewFamiliaritySignals(octokit, 'o', 'r', '2026-04-01T00:00:00Z', ['src/a.ts']);

    expect(result.alice).toBe(1);
  });

  it('counts commit familiarity by login from aliased history', async () => {
    const octokit = {
      graphql: async () => ({
        repository: {
          file0: {
            history: {
              nodes: [{ author: { user: { login: 'Alice' } } }],
            },
          },
          file1: {
            history: {
              nodes: [{ author: { user: { login: 'Bob' } } }, { author: { user: { login: 'Alice' } } }],
            },
          },
        },
      }),
      rest: {
        pulls: {
          listFiles: async () => ({ data: [] }),
        },
      },
    } as OctokitLike;

    const result = await fetchCommitFamiliaritySignals(octokit, 'o', 'r', 'main', '2026-04-01T00:00:00Z', [
      'src/a.ts',
      'src/b.ts',
    ]);

    expect(result.alice).toBe(2);
    expect(result.bob).toBe(1);
  });

  it('expands team members from paginated response', async () => {
    let first = true;
    const octokit = {
      graphql: async () => {
        if (first) {
          first = false;
          return {
            organization: {
              team: {
                members: {
                  pageInfo: { hasNextPage: true, endCursor: 'cursor' },
                  nodes: [{ login: 'Alice' }],
                },
              },
            },
          };
        }

        return {
          organization: {
            team: {
              members: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ login: 'Bob' }],
              },
            },
          },
        };
      },
      rest: {
        pulls: {
          listFiles: async () => ({ data: [] }),
        },
      },
    } as OctokitLike;

    const result = await expandTeamMembers(octokit, 'firebolt', 'db-team');

    expect(result).toEqual(['alice', 'bob']);
  });

  it('collects users with limited availability status', async () => {
    const octokit = {
      graphql: async () => ({
        user0: { login: 'Alice', status: { indicatesLimitedAvailability: true } },
        user1: { login: 'Bob', status: { indicatesLimitedAvailability: false } },
      }),
      rest: {
        pulls: {
          listFiles: async () => ({ data: [] }),
        },
      },
    } as OctokitLike;

    const result = await fetchLimitedAvailabilityUsers(octokit, ['alice', 'bob']);

    expect(result).toEqual(['alice']);
  });

  it('collects users that resolve to null', async () => {
    const octokit = {
      graphql: async () => ({
        user0: { login: 'alice' },
        user1: null,
      }),
      rest: {
        pulls: {
          listFiles: async () => ({ data: [] }),
        },
      },
    } as OctokitLike;

    const result = await fetchDeletedUsers(octokit, ['alice', 'ghost']);
    expect(result).toEqual(['ghost']);
  });

  it('stops activity pagination when page is fully out of window', async () => {
    let calls = 0;
    const octokit = {
      graphql: async () => {
        calls += 1;
        return {
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: true, endCursor: 'cursor' },
              nodes: [
                {
                  updatedAt: '2020-01-01T00:00:00Z',
                  assignees: { nodes: [] },
                  reviewRequests: { nodes: [] },
                  timelineItems: { nodes: [] },
                },
              ],
            },
          },
        };
      },
      rest: {
        pulls: {
          listFiles: async () => ({ data: [] }),
        },
      },
    } as OctokitLike;

    await fetchActivitySignals(octokit, 'o', 'r', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    expect(calls).toBe(1);
  });
});
