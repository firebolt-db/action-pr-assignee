import { describe, expect, it } from 'bun:test';
import { buildCandidatePool, rankCandidates, type ScoreWeights } from '../../src/engine/index.js';
import scenarios from '../fixtures/integration/scenarios.json' with { type: 'json' };

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

interface Scenario {
  name: string;
  earlyExit: '' | 'draft' | 'already_assigned' | 'opted_out' | 'fork_pr';
  codeownersPresent: boolean;
  dryRun: boolean;
  files: Array<{
    path: string;
    loc: number;
    directOwners: string[];
    teamMembers: string[];
    fallbackOwners: string[];
  }>;
  filters: {
    prAuthor: string;
    excludeUsers: string[];
    unavailableReviewers: string[];
    oooUsers: string[];
    deletedUsers: string[];
  };
  signalSeeds: {
    commitFamiliarityLogins: string[];
    reviewFamiliarityLogins: string[];
    suggestedReviewerLogins: string[];
  };
  signalsByLogin: Record<
    string,
    {
      commitCount: number;
      reviewCount: number;
      openAssignedPrs: number;
      pendingReviewRequests: number;
      recentAssignments: number;
    }
  >;
  assignFailsFor: string[];
  expected: {
    skippedReason: string;
    assignmentPerformed: boolean;
    assignee: string;
  };
}

function runScenario(scenario: Scenario): { skippedReason: string; assignmentPerformed: boolean; assignee: string } {
  if (scenario.earlyExit) {
    return {
      skippedReason: scenario.earlyExit,
      assignmentPerformed: false,
      assignee: '',
    };
  }

  const pool = buildCandidatePool({
    codeownersPresent: scenario.codeownersPresent,
    files: scenario.files,
    signalSeeds: scenario.signalSeeds,
    filters: {
      ...scenario.filters,
      botLoginPatterns: [/\[bot\]$/i, /^dependabot$/i, /^renovate$/i],
    },
  });

  if (pool.candidates.length === 0) {
    return {
      skippedReason: 'empty_candidate_pool',
      assignmentPerformed: false,
      assignee: '',
    };
  }

  let ranking;
  try {
    ranking = rankCandidates({
      candidates: pool.candidates,
      signalsByLogin: scenario.signalsByLogin,
      weights: defaultWeights,
    });
  } catch {
    return {
      skippedReason: 'empty_candidate_pool',
      assignmentPerformed: false,
      assignee: '',
    };
  }

  if (scenario.dryRun) {
    return {
      skippedReason: '',
      assignmentPerformed: false,
      assignee: ranking.assignee,
    };
  }

  const attempts = Math.min(3, ranking.ranking.length);
  for (let i = 0; i < attempts; i += 1) {
    const login = ranking.ranking[i]?.login ?? '';
    if (!scenario.assignFailsFor.includes(login)) {
      return {
        skippedReason: '',
        assignmentPerformed: true,
        assignee: login,
      };
    }
  }

  return {
    skippedReason: '',
    assignmentPerformed: false,
    assignee: '',
  };
}

describe('offline integration fixtures', () => {
  for (const scenario of scenarios as unknown as Scenario[]) {
    it(`matches scenario: ${scenario.name}`, () => {
      const result = runScenario(scenario);
      expect(result).toEqual(scenario.expected);
    });
  }
});
