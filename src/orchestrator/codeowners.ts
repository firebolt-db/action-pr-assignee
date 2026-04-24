import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Codeowners from 'codeowners';

export interface ResolvedOwnership {
  directOwners: string[];
  teamRefs: string[];
}

function normalizeOwnerToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed.startsWith('@')) return null;
  return trimmed.slice(1).toLowerCase();
}

export async function buildCodeownersResolver(content: string): Promise<(filePath: string) => ResolvedOwnership> {
  const rootDir = await mkdtemp(join(tmpdir(), 'pr-assignee-codeowners-'));
  const codeownersPath = join(rootDir, '.github', 'CODEOWNERS');
  await mkdir(join(rootDir, '.github'), { recursive: true });
  await writeFile(codeownersPath, content, 'utf8');

  const resolver = new Codeowners(rootDir);

  return (filePath: string) => {
    const owners = resolver.getOwner(filePath).map((owner) => normalizeOwnerToken(owner)).filter(Boolean) as string[];
    const directOwners: string[] = [];
    const teamRefs: string[] = [];

    for (const owner of owners) {
      if (owner.includes('/')) {
        teamRefs.push(owner);
      } else {
        directOwners.push(owner);
      }
    }

    return {
      directOwners: [...new Set(directOwners)],
      teamRefs: [...new Set(teamRefs)],
    };
  };
}
