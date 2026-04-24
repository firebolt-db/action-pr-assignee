import type { OctokitLike } from './types.js';

interface CodeownersResponse {
  repository: {
    root: { text: string } | null;
    github: { text: string } | null;
    docs: { text: string } | null;
  } | null;
}

export interface CodeownersFetchResult {
  found: boolean;
  path: 'CODEOWNERS' | '.github/CODEOWNERS' | 'docs/CODEOWNERS' | null;
  content: string | null;
}

const codeownersQuery = `
  query Codeowners($owner: String!, $repo: String!, $root: String!, $github: String!, $docs: String!) {
    repository(owner: $owner, name: $repo) {
      root: object(expression: $root) { ... on Blob { text } }
      github: object(expression: $github) { ... on Blob { text } }
      docs: object(expression: $docs) { ... on Blob { text } }
    }
  }
`;

export async function fetchCodeownersAtBaseRef(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  baseRef: string,
): Promise<CodeownersFetchResult> {
  const response = (await octokit.graphql(codeownersQuery, {
    owner,
    repo,
    root: `${baseRef}:CODEOWNERS`,
    github: `${baseRef}:.github/CODEOWNERS`,
    docs: `${baseRef}:docs/CODEOWNERS`,
  })) as CodeownersResponse;

  const repository = response.repository;
  if (!repository) {
    return { found: false, path: null, content: null };
  }

  if (repository.root?.text != null) {
    return { found: true, path: 'CODEOWNERS', content: repository.root.text };
  }

  if (repository.github?.text != null) {
    return { found: true, path: '.github/CODEOWNERS', content: repository.github.text };
  }

  if (repository.docs?.text != null) {
    return { found: true, path: 'docs/CODEOWNERS', content: repository.docs.text };
  }

  return { found: false, path: null, content: null };
}
