import { describe, expect, it } from 'bun:test';
import { rankCandidates, type Candidate, type ScoreWeights } from '../../src/engine/index.js';

const defaultWeights: ScoreWeights = {
  weightDirectGte50: 50,
  weightDirectGte20: 35,
  weightDirectFloor: 20,
  weightTeamAny: 20,
  weightFallbackAny: 5,
  weightCodeFamiliarityPerCommit: 5,
  weightCodeFamiliarityMax: 25,
  weightReviewFamiliarityPerReview: 4,
  weightReviewFamiliarityMax: 20,
  weightActiveLoadPerPr: 8,
  weightActiveLoadMax: 24,
  weightPendingReviewPerRequest: 5,
  weightPendingReviewMax: 20,
  weightRecentAssignmentPerPr: 6,
  weightRecentAssignmentMax: 18,
  weightTeamFallbackPenalty: 10,
  weightFallbackOnlyPenalty: 20,
};

describe('rankCandidates', () => {
  it('scores candidates according to component formulas', () => {
    const candidates: Candidate[] = [
      {
        login: 'alice',
        tier: 'direct_gte50',
        directOwnedLoc: 100,
        ownershipLocDenominator: 120,
      },
      {
        login: 'bob',
        tier: 'team_any',
        directOwnedLoc: 0,
        ownershipLocDenominator: 120,
      },
    ];

    const result = rankCandidates({
      candidates,
      weights: defaultWeights,
      signalsByLogin: {
        alice: {
          commitCount: 4,
          reviewCount: 3,
          openAssignedPrs: 2,
          pendingReviewRequests: 1,
          recentAssignments: 1,
        },
        bob: {
          commitCount: 1,
          reviewCount: 0,
          openAssignedPrs: 0,
          pendingReviewRequests: 0,
          recentAssignments: 0,
        },
      },
    });

    expect(result.assignee).toBe('alice');
    expect(result.ranking[0]?.total).toBe(55);
    expect(result.ranking[1]?.total).toBe(15);
  });

  it('applies deterministic tie-break chain', () => {
    const candidates: Candidate[] = [
      {
        login: 'bob',
        tier: 'direct_gte20',
        directOwnedLoc: 30,
        ownershipLocDenominator: 100,
      },
      {
        login: 'alice',
        tier: 'direct_gte20',
        directOwnedLoc: 30,
        ownershipLocDenominator: 100,
      },
    ];

    const result = rankCandidates({
      candidates,
      weights: defaultWeights,
      signalsByLogin: {
        bob: {
          commitCount: 0,
          reviewCount: 0,
          openAssignedPrs: 1,
          pendingReviewRequests: 0,
          recentAssignments: 0,
        },
        alice: {
          commitCount: 0,
          reviewCount: 0,
          openAssignedPrs: 0,
          pendingReviewRequests: 0,
          recentAssignments: 0,
        },
      },
    });

    expect(result.assignee).toBe('alice');
    expect(result.ranking.map((candidate) => candidate.login)).toEqual(['alice', 'bob']);
  });

  it('throws when all totals are non-positive', () => {
    const candidates: Candidate[] = [
      {
        login: 'alice',
        tier: 'none',
        directOwnedLoc: 0,
        ownershipLocDenominator: 100,
      },
    ];

    expect(() =>
      rankCandidates({
        candidates,
        weights: defaultWeights,
        signalsByLogin: {
          alice: {
            commitCount: 0,
            reviewCount: 0,
            openAssignedPrs: 3,
            pendingReviewRequests: 1,
            recentAssignments: 1,
          },
        },
      }),
    ).toThrow('all candidates have non-positive scores');
  });
});
