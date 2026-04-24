import type { OctokitLike } from './types.js';

export async function fetchRenamePreviousPathByCurrentFilename(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<Record<string, string>> {
  const previousPathByCurrentPath: Record<string, string> = {};

  let page = 1;
  while (true) {
    const response = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });

    if (response.data.length === 0) {
      break;
    }

    for (const file of response.data) {
      if (file.status === 'renamed' && file.previous_filename) {
        previousPathByCurrentPath[file.filename] = file.previous_filename;
      }
    }

    if (response.data.length < 100) {
      break;
    }

    page += 1;
  }

  return previousPathByCurrentPath;
}
