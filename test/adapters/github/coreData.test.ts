import { describe, expect, it } from 'bun:test';
import { fetchCodeownersAtBaseRef } from '../../../src/adapters/github/codeowners.js';
import { fetchPrCoreData } from '../../../src/adapters/github/prCore.js';
import { fetchRenamePreviousPathByCurrentFilename } from '../../../src/adapters/github/renameRecovery.js';
import type { OctokitLike } from '../../../src/adapters/github/types.js';

describe('github core adapters', () => {
  it('prefers root CODEOWNERS path order', async () => {
    const octokit = {
      graphql: async () => ({
        repository: {
          root: { text: '* @alice' },
          github: { text: '* @bob' },
          docs: { text: '* @carol' },
        },
      }),
      rest: {
        pulls: {
          listFiles: async () => ({ data: [] }),
        },
      },
    } satisfies OctokitLike;

    const result = await fetchCodeownersAtBaseRef(octokit, 'o', 'r', 'main');

    expect(result.path).toBe('CODEOWNERS');
    expect(result.content).toBe('* @alice');
  });

  it('collects paginated PR files and static fields', async () => {
    let calls = 0;
    const octokit = {
      graphql: async (_query: string, variables?: Record<string, unknown>) => {
        calls += 1;
        if (variables?.cursor == null) {
          return {
            repository: {
              pullRequest: {
                id: 'PR_node_1',
                number: 42,
                isDraft: false,
                author: { login: 'Author' },
                assignees: { nodes: [{ login: 'Alice' }] },
                labels: { nodes: [{ name: 'feature' }] },
                reviewRequests: { nodes: [{ requestedReviewer: { login: 'Bob' } }] },
                baseRepository: { owner: { login: 'firebolt' }, name: 'repo' },
                headRepository: { owner: { login: 'forker' }, name: 'repo' },
                baseRefName: 'main',
                files: {
                  pageInfo: { hasNextPage: true, endCursor: 'cursor_1' },
                  nodes: [{ path: 'src/a.ts', additions: 2, deletions: 1, changeType: 'MODIFIED' }],
                },
                suggestedReviewers: [{ reviewer: { login: 'Carol' } }],
              },
            },
          };
        }

        return {
          repository: {
            pullRequest: {
              id: 'PR_node_1',
              number: 42,
              isDraft: false,
              author: { login: 'Author' },
              assignees: { nodes: [{ login: 'Alice' }] },
              labels: { nodes: [{ name: 'feature' }] },
              reviewRequests: { nodes: [{ requestedReviewer: { login: 'Bob' } }] },
              baseRepository: { owner: { login: 'firebolt' }, name: 'repo' },
              headRepository: { owner: { login: 'forker' }, name: 'repo' },
              baseRefName: 'main',
              files: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ path: 'src/b.ts', additions: 10, deletions: 0, changeType: 'ADDED' }],
              },
              suggestedReviewers: [{ reviewer: { login: 'Carol' } }],
            },
          },
        };
      },
      rest: {
        pulls: {
          listFiles: async () => ({ data: [] }),
        },
      },
    } satisfies OctokitLike;

    const result = await fetchPrCoreData(octokit, 'o', 'r', 42);

    expect(calls).toBe(2);
    expect(result.files).toHaveLength(2);
    expect(result.authorLogin).toBe('Author');
    expect(result.assignees).toEqual(['alice']);
    expect(result.requestedReviewers).toEqual(['bob']);
    expect(result.suggestedReviewers).toEqual(['carol']);
  });

  it('maps REST rename responses by current filename', async () => {
    const octokit = {
      graphql: async () => ({ repository: null }),
      rest: {
        pulls: {
          listFiles: async ({ page }: { page: number }) => {
            if (page === 1) {
              return {
                data: [
                  { filename: 'src/new.ts', previous_filename: 'src/old.ts', status: 'renamed' },
                  { filename: 'src/other.ts', status: 'modified' },
                ],
              };
            }

            return { data: [] };
          },
        },
      },
    } as OctokitLike;

    const result = await fetchRenamePreviousPathByCurrentFilename(octokit, 'o', 'r', 1);

    expect(result).toEqual({
      'src/new.ts': 'src/old.ts',
    });
  });
});
