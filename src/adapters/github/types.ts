export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface PrChangedFile {
  path: string;
  additions: number;
  deletions: number;
  changeType: 'ADDED' | 'MODIFIED' | 'REMOVED' | 'RENAMED' | 'COPIED' | 'CHANGED' | string;
}

export interface PrCoreData {
  nodeId: string;
  number: number;
  isDraft: boolean;
  authorLogin: string | null;
  assignees: string[];
  labels: string[];
  requestedReviewers: string[];
  baseOwner: string;
  baseRepo: string;
  baseRef: string;
  headOwner: string;
  headRepo: string;
  files: PrChangedFile[];
  suggestedReviewers: string[];
}

export interface OctokitLike {
  graphql: (query: string, variables?: Record<string, unknown>) => Promise<unknown>;
  rest: {
    pulls: {
      listFiles: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page: number;
        page: number;
      }) => Promise<{
        data: Array<{
          filename: string;
          previous_filename?: string;
          status: string;
        }>;
      }>;
    };
  };
}
