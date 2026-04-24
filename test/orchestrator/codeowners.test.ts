import { describe, expect, it } from 'bun:test';
import { buildCodeownersResolver } from '../../src/orchestrator/codeowners.js';

describe('buildCodeownersResolver', () => {
  it('classifies fallback pattern matches separately', async () => {
    const resolver = await buildCodeownersResolver(
      ['* @org/everyone @carol', 'src/** @alice @org/app-team'].join('\n'),
      [/^\*$/],
    );

    const srcMatch = resolver('src/index.ts');
    expect(srcMatch.directOwners).toEqual(['alice']);
    expect(srcMatch.teamRefs).toEqual(['org/app-team']);
    expect(srcMatch.fallbackOwners).toEqual([]);
    expect(srcMatch.fallbackTeamRefs).toEqual([]);

    const fallbackMatch = resolver('docs/readme.md');
    expect(fallbackMatch.directOwners).toEqual([]);
    expect(fallbackMatch.teamRefs).toEqual([]);
    expect(fallbackMatch.fallbackOwners).toEqual(['carol']);
    expect(fallbackMatch.fallbackTeamRefs).toEqual(['org/everyone']);
  });
});
