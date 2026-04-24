import type { OctokitLike } from './types.js';

export interface ActivitySignals {
  openAssignedPrs: number;
  pendingReviewRequests: number;
  recentAssignments: number;
}

export interface ReviewSignals {
  distinctOverlappingReviewedPrs: number;
}

export interface SignalSnapshot {
  activity: ActivitySignals;
  review: ReviewSignals;
  commitsOnTouchedPaths: number;
}

export type SignalsByLogin = Record<string, SignalSnapshot>;

function emptySignalSnapshot(): SignalSnapshot {
  return {
    activity: {
      openAssignedPrs: 0,
      pendingReviewRequests: 0,
      recentAssignments: 0,
    },
    review: {
      distinctOverlappingReviewedPrs: 0,
    },
    commitsOnTouchedPaths: 0,
  };
}

function ensureSnapshot(signalsByLogin: SignalsByLogin, login: string): SignalSnapshot {
  if (!signalsByLogin[login]) {
    signalsByLogin[login] = emptySignalSnapshot();
  }

  return signalsByLogin[login];
}

const activityQuery = `
  query ActivityBundle($owner: String!, $repo: String!, $cursor: String, $since: DateTime!) {
    repository(owner: $owner, name: $repo) {
      pullRequests(states: [OPEN], first: 50, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          updatedAt
          assignees(first: 50) { nodes { login } }
          reviewRequests(first: 50) {
            nodes {
              asCodeOwner
              requestedReviewer {
                ... on User { login }
                ... on Team {
                  slug
                  organization { login }
                }
              }
            }
          }
          timelineItems(itemTypes: [ASSIGNED_EVENT], first: 100, since: $since) {
            nodes {
              ... on AssignedEvent {
                createdAt
                assignee {
                  ... on User { login }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export async function fetchActivitySignals(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  activitySinceIso: string,
  recentAssignmentSinceIso: string,
  teamMembersByTeamSlug: Record<string, string[]> = {},
): Promise<SignalsByLogin> {
  const signalsByLogin: SignalsByLogin = {};
  const teamMembersCache: Record<string, string[]> = { ...teamMembersByTeamSlug };

  let cursor: string | null = null;
  while (true) {
    const response = (await octokit.graphql(activityQuery, {
      owner,
      repo,
      cursor,
      since: recentAssignmentSinceIso,
    })) as {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            updatedAt: string;
            assignees: { nodes: Array<{ login: string }> };
            reviewRequests: {
              nodes: Array<{
                asCodeOwner?: boolean;
                requestedReviewer: { login?: string; slug?: string; organization?: { login: string } } | null;
              }>;
            };
            timelineItems: {
              nodes: Array<{
                createdAt: string;
                assignee: { login: string } | null;
              }>;
            };
          }>;
        };
      } | null;
    };

    const pullRequests = response.repository?.pullRequests;
    if (!pullRequests) break;

    let pageHasRecentPr = false;
    for (const pr of pullRequests.nodes) {
      if (pr.updatedAt < activitySinceIso) {
        continue;
      }
      pageHasRecentPr = true;

      const assignees = pr.assignees.nodes.map((node) => node.login.toLowerCase());
      for (const assignee of assignees) {
        ensureSnapshot(signalsByLogin, assignee).activity.openAssignedPrs += 1;
      }

      for (const reviewRequest of pr.reviewRequests.nodes) {
        const reviewer = reviewRequest.requestedReviewer;
        if (!reviewer) continue;

        if (reviewer.login) {
          const login = reviewer.login.toLowerCase();
          ensureSnapshot(signalsByLogin, login).activity.pendingReviewRequests += 1;
          continue;
        }

        if (reviewer.slug && reviewer.organization?.login) {
          const teamKey = `${reviewer.organization.login.toLowerCase()}/${reviewer.slug.toLowerCase()}`;
          if (!teamMembersCache[teamKey]) {
            try {
              teamMembersCache[teamKey] = await expandTeamMembers(
                octokit,
                reviewer.organization.login,
                reviewer.slug,
              );
            } catch {
              teamMembersCache[teamKey] = [];
            }
          }

          const members = teamMembersCache[teamKey] ?? [];
          for (const memberLogin of members) {
            const login = memberLogin.toLowerCase();
            ensureSnapshot(signalsByLogin, login).activity.pendingReviewRequests += 1;
          }
        }
      }

      const recentlyAssignedLoginsForPr = new Set<string>();
      for (const event of pr.timelineItems.nodes) {
        if (event.createdAt < recentAssignmentSinceIso) continue;
        const login = event.assignee?.login?.toLowerCase();
        if (!login) continue;
        recentlyAssignedLoginsForPr.add(login);
      }

      for (const login of recentlyAssignedLoginsForPr) {
        ensureSnapshot(signalsByLogin, login).activity.recentAssignments += 1;
      }
    }

    if (!pullRequests.pageInfo.hasNextPage || !pageHasRecentPr) break;
    cursor = pullRequests.pageInfo.endCursor;
  }

  return signalsByLogin;
}

const reviewFamiliarityQuery = `
  query ReviewFamiliarity($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequests(states: [OPEN, MERGED, CLOSED], first: 20, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          updatedAt
          files(first: 100) { nodes { path } }
          reviews(first: 100) { nodes { author { login } submittedAt } }
        }
      }
    }
  }
`;

export async function fetchReviewFamiliaritySignals(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  reviewWindowSinceIso: string,
  overlapPaths: string[],
): Promise<Record<string, number>> {
  const countsByLogin: Record<string, number> = {};
  const overlapPathSet = new Set(overlapPaths);

  let cursor: string | null = null;
  while (true) {
    const response = (await octokit.graphql(reviewFamiliarityQuery, {
      owner,
      repo,
      cursor,
    })) as {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            updatedAt: string;
            files: { nodes: Array<{ path: string }> };
            reviews: { nodes: Array<{ author: { login: string } | null; submittedAt: string | null }> };
          }>;
        };
      } | null;
    };

    const pullRequests = response.repository?.pullRequests;
    if (!pullRequests) break;

    let pageHasRecentPr = false;
    for (const pr of pullRequests.nodes) {
      if (pr.updatedAt >= reviewWindowSinceIso) {
        pageHasRecentPr = true;
      }

      const hasOverlap = pr.files.nodes.some((file) => overlapPathSet.has(file.path));
      if (!hasOverlap) continue;

      const reviewersForPr = new Set<string>();
      for (const review of pr.reviews.nodes) {
        if (!review.submittedAt || review.submittedAt < reviewWindowSinceIso) continue;
        const login = review.author?.login?.toLowerCase();
        if (!login) continue;
        reviewersForPr.add(login);
      }

      for (const reviewer of reviewersForPr) {
        countsByLogin[reviewer] = (countsByLogin[reviewer] ?? 0) + 1;
      }
    }

    if (!pullRequests.pageInfo.hasNextPage || !pageHasRecentPr) break;
    cursor = pullRequests.pageInfo.endCursor;
  }

  return countsByLogin;
}

function buildCommitHistoryQuery(batchSize: number): string {
  const segments: string[] = [];
  for (let i = 0; i < batchSize; i += 1) {
    segments.push(`
      file${i}: object(expression: $branch) {
        ... on Commit {
          history(path: $path${i}, since: $since) {
            nodes { author { user { login } } }
          }
        }
      }
    `);
  }

  const variableDefs = [`$owner: String!`, `$repo: String!`, `$branch: String!`, `$since: GitTimestamp!`];
  for (let i = 0; i < batchSize; i += 1) {
    variableDefs.push(`$path${i}: String!`);
  }

  return `
    query CommitFamiliarity(${variableDefs.join(', ')}) {
      repository(owner: $owner, name: $repo) {
        ${segments.join('\n')}
      }
    }
  `;
}

export async function fetchCommitFamiliaritySignals(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  branchExpression: string,
  sinceIso: string,
  paths: string[],
): Promise<Record<string, number>> {
  const countsByLogin: Record<string, number> = {};

  const batchSize = 20;
  for (let start = 0; start < paths.length; start += batchSize) {
    const batch = paths.slice(start, start + batchSize);
    const query = buildCommitHistoryQuery(batch.length);

    const variables: Record<string, unknown> = {
      owner,
      repo,
      branch: branchExpression,
      since: sinceIso,
    };
    for (let i = 0; i < batch.length; i += 1) {
      variables[`path${i}`] = batch[i];
    }

    const response = (await octokit.graphql(query, variables)) as {
      repository: Record<
        string,
        | {
            history: {
              nodes: Array<{
                author: { user: { login: string } | null } | null;
              }>;
            };
          }
        | null
      > | null;
    };

    const repository = response.repository ?? {};
    for (let i = 0; i < batch.length; i += 1) {
      const history = repository[`file${i}`]?.history.nodes ?? [];
      for (const commit of history) {
        const login = commit.author?.user?.login?.toLowerCase();
        if (!login) continue;
        countsByLogin[login] = (countsByLogin[login] ?? 0) + 1;
      }
    }
  }

  return countsByLogin;
}

const teamMembersQuery = `
  query TeamMembers($org: String!, $slug: String!, $cursor: String) {
    organization(login: $org) {
      team(slug: $slug) {
        members(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { login }
        }
      }
    }
  }
`;

export async function expandTeamMembers(
  octokit: OctokitLike,
  org: string,
  teamSlug: string,
): Promise<string[]> {
  const members: string[] = [];
  let cursor: string | null = null;

  while (true) {
    const response = (await octokit.graphql(teamMembersQuery, {
      org,
      slug: teamSlug,
      cursor,
    })) as {
      organization: {
        team: {
          members: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{ login: string }>;
          };
        } | null;
      } | null;
    };

    const membersConnection = response.organization?.team?.members;
    if (!membersConnection) {
      return [];
    }

    members.push(...membersConnection.nodes.map((node) => node.login.toLowerCase()));

    if (!membersConnection.pageInfo.hasNextPage) {
      break;
    }
    cursor = membersConnection.pageInfo.endCursor;
  }

  return [...new Set(members)];
}

export async function fetchLimitedAvailabilityUsers(
  octokit: OctokitLike,
  logins: string[],
): Promise<string[]> {
  const uniqueLogins = [...new Set(logins.map((login) => login.toLowerCase()))];
  const outOfOffice: string[] = [];
  const batchSize = 20;

  for (let start = 0; start < uniqueLogins.length; start += batchSize) {
    const batch = uniqueLogins.slice(start, start + batchSize);
    const variableDefs = batch.map((_, index) => `$login${index}: String!`).join(', ');
    const fields = batch
      .map(
        (_, index) => `
      user${index}: user(login: $login${index}) {
        login
        status {
          indicatesLimitedAvailability
        }
      }`,
      )
      .join('\n');

    const query = `
      query CandidateStatus(${variableDefs}) {
        ${fields}
      }
    `;

    const variables: Record<string, unknown> = {};
    for (let index = 0; index < batch.length; index += 1) {
      variables[`login${index}`] = batch[index];
    }

    const response = (await octokit.graphql(query, variables)) as Record<
      string,
      { login: string; status: { indicatesLimitedAvailability: boolean } | null } | null
    >;

    for (let index = 0; index < batch.length; index += 1) {
      const user = response[`user${index}`];
      if (!user) continue;
      if (user.status?.indicatesLimitedAvailability) {
        outOfOffice.push(user.login.toLowerCase());
      }
    }
  }

  return [...new Set(outOfOffice)];
}

export async function fetchDeletedUsers(
  octokit: OctokitLike,
  logins: string[],
): Promise<string[]> {
  const uniqueLogins = [...new Set(logins.map((login) => login.toLowerCase()))];
  const deletedUsers: string[] = [];
  const batchSize = 20;

  for (let start = 0; start < uniqueLogins.length; start += batchSize) {
    const batch = uniqueLogins.slice(start, start + batchSize);
    const variableDefs = batch.map((_, index) => `$login${index}: String!`).join(', ');
    const fields = batch
      .map(
        (_, index) => `
      user${index}: user(login: $login${index}) {
        login
      }`,
      )
      .join('\n');

    const query = `
      query CandidateExistence(${variableDefs}) {
        ${fields}
      }
    `;

    const variables: Record<string, unknown> = {};
    for (let index = 0; index < batch.length; index += 1) {
      variables[`login${index}`] = batch[index];
    }

    const response = (await octokit.graphql(query, variables)) as Record<string, { login: string } | null>;
    for (let index = 0; index < batch.length; index += 1) {
      const key = `user${index}`;
      if (response[key] == null) {
        deletedUsers.push(batch[index]!);
      }
    }
  }

  return [...new Set(deletedUsers)];
}
