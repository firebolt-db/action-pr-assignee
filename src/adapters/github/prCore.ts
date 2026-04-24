import type { OctokitLike, PrChangedFile, PrCoreData } from './types.js';

interface PrCoreGraphQlResponse {
  repository: {
    defaultBranchRef: { name: string } | null;
    pullRequest: {
      id: string;
      number: number;
      isDraft: boolean;
      author: { login: string } | null;
      assignees: { nodes: Array<{ login: string }> };
      labels: { nodes: Array<{ name: string }> };
      reviewRequests: {
        nodes: Array<{
          requestedReviewer: { login: string } | null;
        }>;
      };
      baseRepository: {
        owner: { login: string };
        name: string;
      };
      headRepository: {
        owner: { login: string };
        name: string;
      } | null;
      baseRefName: string;
      files: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          path: string;
          additions: number;
          deletions: number;
          changeType: string;
        }>;
      };
      suggestedReviewers: Array<{
        reviewer: { login: string } | null;
      }>;
    } | null;
  } | null;
}

const prCoreQuery = `
  query PrCore($owner: String!, $repo: String!, $pullNumber: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      defaultBranchRef { name }
      pullRequest(number: $pullNumber) {
        id
        number
        isDraft
        author { login }
        assignees(first: 50) { nodes { login } }
        labels(first: 50) { nodes { name } }
        reviewRequests(first: 50) {
          nodes {
            requestedReviewer {
              ... on User { login }
            }
          }
        }
        baseRepository { owner { login } name }
        headRepository { owner { login } name }
        baseRefName
        files(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { path additions deletions changeType }
        }
        suggestedReviewers {
          reviewer {
            ... on User { login }
          }
        }
      }
    }
  }
`;

function mapFiles(nodes: Array<{ path: string; additions: number; deletions: number; changeType: string }>): PrChangedFile[] {
  return nodes.map((node) => ({
    path: node.path,
    additions: node.additions,
    deletions: node.deletions,
    changeType: node.changeType,
  }));
}

export async function fetchPrCoreData(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PrCoreData> {
  let cursor: string | null = null;
  const allFiles: PrChangedFile[] = [];

  let staticFields: Omit<PrCoreData, 'files'> | null = null;

  while (true) {
    const response = (await octokit.graphql(prCoreQuery, {
      owner,
      repo,
      pullNumber,
      cursor,
    })) as PrCoreGraphQlResponse;

    const pr = response.repository?.pullRequest;
    if (!pr) {
      throw new Error(`Pull request ${owner}/${repo}#${pullNumber} not found`);
    }

    if (!staticFields) {
      const headRepo = pr.headRepository;
      staticFields = {
        nodeId: pr.id,
        number: pr.number,
        isDraft: pr.isDraft,
        authorLogin: pr.author?.login ?? null,
        assignees: pr.assignees.nodes.map((node) => node.login.toLowerCase()),
        labels: pr.labels.nodes.map((node) => node.name),
        requestedReviewers: pr.reviewRequests.nodes
          .flatMap((node) => (node.requestedReviewer?.login ? [node.requestedReviewer.login.toLowerCase()] : [])),
        baseOwner: pr.baseRepository.owner.login,
        baseRepo: pr.baseRepository.name,
        baseRef: pr.baseRefName,
        defaultBranch: response.repository?.defaultBranchRef?.name ?? pr.baseRefName,
        headOwner: headRepo?.owner.login ?? pr.baseRepository.owner.login,
        headRepo: headRepo?.name ?? pr.baseRepository.name,
        suggestedReviewers: pr.suggestedReviewers
          .flatMap((reviewer) => (reviewer.reviewer?.login ? [reviewer.reviewer.login.toLowerCase()] : [])),
      };
    }

    allFiles.push(...mapFiles(pr.files.nodes));

    if (!pr.files.pageInfo.hasNextPage) {
      break;
    }

    cursor = pr.files.pageInfo.endCursor;
  }

  return {
    ...staticFields,
    files: allFiles,
  };
}
