import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Codeowners from 'codeowners';

export interface ResolvedOwnership {
  directOwners: string[];
  teamRefs: string[];
  fallbackOwners: string[];
  fallbackTeamRefs: string[];
}

function normalizeOwnerToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed.startsWith('@')) return null;
  return trimmed.slice(1).toLowerCase();
}

export async function buildCodeownersResolver(
  content: string,
  fallbackPatterns: RegExp[],
): Promise<(filePath: string) => ResolvedOwnership> {
  const rootDir = await mkdtemp(join(tmpdir(), 'pr-assignee-codeowners-'));
  const codeownersPath = join(rootDir, '.github', 'CODEOWNERS');
  await mkdir(join(rootDir, '.github'), { recursive: true });
  await writeFile(codeownersPath, content, 'utf8');

  const resolver = new Codeowners(rootDir);
  const ownerEntries = (resolver as unknown as {
    ownerEntries?: Array<{
      path: string;
      usernames: string[];
      match: (filePath: string) => boolean;
    }>;
  }).ownerEntries;

  return (filePath: string) => {
    const matchingEntry = ownerEntries?.find((entry) => entry.match(filePath));
    const matchedPattern = matchingEntry?.path ?? '';
    const owners = resolver.getOwner(filePath).map((owner) => normalizeOwnerToken(owner)).filter(Boolean) as string[];
    const isFallbackMatch = fallbackPatterns.some((pattern) => pattern.test(matchedPattern));

    const directOwners: string[] = [];
    const teamRefs: string[] = [];
    const fallbackOwners: string[] = [];
    const fallbackTeamRefs: string[] = [];

    for (const owner of owners) {
      if (isFallbackMatch) {
        if (owner.includes('/')) {
          fallbackTeamRefs.push(owner);
        } else {
          fallbackOwners.push(owner);
        }
      } else {
        if (owner.includes('/')) {
          teamRefs.push(owner);
        } else {
          directOwners.push(owner);
        }
      }
    }

    return {
      directOwners: [...new Set(directOwners)],
      teamRefs: [...new Set(teamRefs)],
      fallbackOwners: [...new Set(fallbackOwners)],
      fallbackTeamRefs: [...new Set(fallbackTeamRefs)],
    };
  };
}
