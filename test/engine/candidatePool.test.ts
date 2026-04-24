import { describe, expect, it } from 'bun:test';
import { buildCandidatePool, type BuildCandidatePoolInput } from '../../src/engine/index.js';

function makeInput(overrides: Partial<BuildCandidatePoolInput> = {}): BuildCandidatePoolInput {
  return {
    codeownersPresent: true,
    files: [
      {
        path: 'src/a.ts',
        loc: 80,
        directOwners: ['alice'],
        teamMembers: ['bob'],
        fallbackOwners: ['carol'],
      },
      {
        path: 'src/b.ts',
        loc: 20,
        directOwners: ['alice'],
        teamMembers: [],
        fallbackOwners: ['carol'],
      },
    ],
    filters: {
      prAuthor: 'zoe',
      excludeUsers: [],
      unavailableReviewers: [],
      botLoginPatterns: [/\[bot\]$/i],
      oooUsers: [],
      deletedUsers: [],
    },
    signalSeeds: {
      commitFamiliarityLogins: ['dave'],
      reviewFamiliarityLogins: ['eve'],
      suggestedReviewerLogins: ['frank'],
    },
    ...overrides,
  };
}

describe('buildCandidatePool', () => {
  it('builds codeowners candidates with expected tiers', () => {
    const result = buildCandidatePool(makeInput());

    expect(result.usedSignalFallback).toBe(false);
    expect(result.candidates.map((candidate) => [candidate.login, candidate.tier])).toEqual([
      ['alice', 'direct_gte50'],
      ['bob', 'team_any'],
      ['carol', 'fallback_any'],
    ]);
  });

  it('falls back to signal seeds when codeowners file is absent', () => {
    const result = buildCandidatePool(
      makeInput({
        codeownersPresent: false,
      }),
    );

    expect(result.usedSignalFallback).toBe(true);
    expect(result.candidates.map((candidate) => candidate.login)).toEqual(['dave', 'eve', 'frank']);
    expect(result.candidates.every((candidate) => candidate.tier === 'none')).toBe(true);
  });

  it('falls back to signal seeds when codeowners candidates are fully filtered', () => {
    const result = buildCandidatePool(
      makeInput({
        filters: {
          prAuthor: 'zoe',
          excludeUsers: ['alice', 'bob', 'carol'],
          unavailableReviewers: [],
          botLoginPatterns: [/\[bot\]$/i],
          oooUsers: [],
          deletedUsers: [],
        },
      }),
    );

    expect(result.usedSignalFallback).toBe(true);
    expect(result.candidates.map((candidate) => candidate.login)).toEqual(['dave', 'eve', 'frank']);
  });

  it('removes author, excluded users, unavailable users, bots, and deleted users', () => {
    const result = buildCandidatePool(
      makeInput({
        signalSeeds: {
          commitFamiliarityLogins: ['zoe', 'alice[bot]', 'ivy', 'jane', 'kate'],
          reviewFamiliarityLogins: [],
          suggestedReviewerLogins: [],
        },
        codeownersPresent: false,
        filters: {
          prAuthor: 'zoe',
          excludeUsers: ['ivy'],
          unavailableReviewers: ['jane'],
          botLoginPatterns: [/\[bot\]$/i],
          oooUsers: [],
          deletedUsers: ['kate'],
        },
      }),
    );

    expect(result.candidates).toEqual([]);
  });

  it('keeps strongest ownership tier when candidate appears in multiple routes', () => {
    const result = buildCandidatePool(
      makeInput({
        files: [
          {
            path: 'src/a.ts',
            loc: 100,
            directOwners: ['alice'],
            teamMembers: ['alice'],
            fallbackOwners: ['alice'],
          },
        ],
      }),
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.tier).toBe('direct_gte50');
  });
});
