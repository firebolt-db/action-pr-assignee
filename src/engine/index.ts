export type OwnershipTier = 'direct_gte50' | 'direct_gte20' | 'direct_floor' | 'team_any' | 'fallback_any' | 'none';

export interface ChangedFileOwnership {
  path: string;
  loc: number;
  directOwners: string[];
  teamMembers: string[];
  fallbackOwners: string[];
}

export interface SignalSeeds {
  commitFamiliarityLogins: string[];
  reviewFamiliarityLogins: string[];
  suggestedReviewerLogins: string[];
}

export interface CandidatePoolFilters {
  prAuthor: string;
  excludeUsers: string[];
  unavailableReviewers: string[];
  botLoginPatterns: RegExp[];
  oooUsers: string[];
  deletedUsers: string[];
}

export interface BuildCandidatePoolInput {
  codeownersPresent: boolean;
  files: ChangedFileOwnership[];
  filters: CandidatePoolFilters;
  signalSeeds: SignalSeeds;
}

export interface Candidate {
  login: string;
  tier: OwnershipTier;
  directOwnedLoc: number;
  ownershipLocDenominator: number;
}

export interface BuildCandidatePoolResult {
  candidates: Candidate[];
  usedSignalFallback: boolean;
}

export interface CandidateSignalStats {
  commitCount: number;
  reviewCount: number;
  openAssignedPrs: number;
  pendingReviewRequests: number;
  recentAssignments: number;
}

export interface ScoreWeights {
  weightDirectGte50: number;
  weightDirectGte20: number;
  weightDirectFloor: number;
  weightTeamAny: number;
  weightFallbackAny: number;
  weightCodeFamiliarityPerCommit: number;
  weightCodeFamiliarityMax: number;
  weightReviewFamiliarityPerReview: number;
  weightReviewFamiliarityMax: number;
  weightActiveLoadPerPr: number;
  weightActiveLoadMax: number;
  weightPendingReviewPerRequest: number;
  weightPendingReviewMax: number;
  weightRecentAssignmentPerPr: number;
  weightRecentAssignmentMax: number;
  weightTeamFallbackPenalty: number;
  weightFallbackOnlyPenalty: number;
}

export interface CandidateScoreComponents {
  direct_ownership: number;
  code_familiarity: number;
  review_familiarity: number;
  active_load: number;
  pending_review: number;
  recent_assignment: number;
  team_fallback: number;
  fallback_only: number;
}

export interface RankedCandidate {
  login: string;
  total: number;
  tier: OwnershipTier;
  components: CandidateScoreComponents;
}

export interface RankCandidatesInput {
  candidates: Candidate[];
  signalsByLogin: Record<string, CandidateSignalStats>;
  weights: ScoreWeights;
}

export interface RankCandidatesResult {
  ranking: RankedCandidate[];
  assignee: string;
}

const tierRank: Record<OwnershipTier, number> = {
  direct_gte50: 5,
  direct_gte20: 4,
  direct_floor: 3,
  team_any: 2,
  fallback_any: 1,
  none: 0,
};

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function dedupeLogins(logins: string[]): string[] {
  return [...new Set(logins.map(normalizeLogin).filter(Boolean))];
}

function toSet(logins: string[]): Set<string> {
  return new Set(dedupeLogins(logins));
}

function pickDirectTier(ratio: number): OwnershipTier {
  if (ratio >= 0.5) return 'direct_gte50';
  if (ratio >= 0.2) return 'direct_gte20';
  return 'direct_floor';
}

function strongerTier(a: OwnershipTier, b: OwnershipTier): OwnershipTier {
  return tierRank[a] >= tierRank[b] ? a : b;
}

function isExcludedByPattern(login: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(login));
}

function shouldExclude(login: string, filters: CandidatePoolFilters): boolean {
  const normalized = normalizeLogin(login);
  if (!normalized) return true;
  if (normalized === normalizeLogin(filters.prAuthor)) return true;
  if (toSet(filters.excludeUsers).has(normalized)) return true;
  if (toSet(filters.unavailableReviewers).has(normalized)) return true;
  if (toSet(filters.oooUsers).has(normalized)) return true;
  if (toSet(filters.deletedUsers).has(normalized)) return true;
  return isExcludedByPattern(normalized, filters.botLoginPatterns);
}

function computeCodeownersCandidates(input: BuildCandidatePoolInput): Candidate[] {
  const ownershipDenominator = input.files.reduce((sum, file) => sum + file.loc, 0);

  const byLogin = new Map<
    string,
    {
      directOwnedLoc: number;
      matchedByTeam: boolean;
      matchedByFallback: boolean;
    }
  >();

  for (const file of input.files) {
    const loc = Math.max(0, file.loc);
    for (const directOwner of dedupeLogins(file.directOwners)) {
      const current = byLogin.get(directOwner) ?? {
        directOwnedLoc: 0,
        matchedByTeam: false,
        matchedByFallback: false,
      };

      current.directOwnedLoc += loc;
      byLogin.set(directOwner, current);
    }

    for (const teamMember of dedupeLogins(file.teamMembers)) {
      const current = byLogin.get(teamMember) ?? {
        directOwnedLoc: 0,
        matchedByTeam: false,
        matchedByFallback: false,
      };
      current.matchedByTeam = true;
      byLogin.set(teamMember, current);
    }

    for (const fallbackOwner of dedupeLogins(file.fallbackOwners)) {
      const current = byLogin.get(fallbackOwner) ?? {
        directOwnedLoc: 0,
        matchedByTeam: false,
        matchedByFallback: false,
      };
      current.matchedByFallback = true;
      byLogin.set(fallbackOwner, current);
    }
  }

  return [...byLogin.entries()].map(([login, meta]) => {
    let tier: OwnershipTier = 'none';
    if (meta.directOwnedLoc > 0 && ownershipDenominator > 0) {
      tier = pickDirectTier(meta.directOwnedLoc / ownershipDenominator);
    } else if (meta.matchedByTeam) {
      tier = 'team_any';
    } else if (meta.matchedByFallback) {
      tier = 'fallback_any';
    }

    return {
      login,
      tier,
      directOwnedLoc: meta.directOwnedLoc,
      ownershipLocDenominator: ownershipDenominator,
    };
  });
}

function applyFilters(candidates: Candidate[], filters: CandidatePoolFilters): Candidate[] {
  return candidates.filter((candidate) => !shouldExclude(candidate.login, filters));
}

function buildSignalSeedCandidates(signalSeeds: SignalSeeds): Candidate[] {
  const uniqueSignalLogins = dedupeLogins([
    ...signalSeeds.commitFamiliarityLogins,
    ...signalSeeds.reviewFamiliarityLogins,
    ...signalSeeds.suggestedReviewerLogins,
  ]);

  return uniqueSignalLogins.map((login) => ({
    login,
    tier: 'none' as const,
    directOwnedLoc: 0,
    ownershipLocDenominator: 0,
  }));
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const byLogin = new Map<string, Candidate>();

  for (const candidate of candidates) {
    const existing = byLogin.get(candidate.login);
    if (!existing) {
      byLogin.set(candidate.login, candidate);
      continue;
    }

    const tier = strongerTier(existing.tier, candidate.tier);
    byLogin.set(candidate.login, {
      ...existing,
      tier,
      directOwnedLoc: Math.max(existing.directOwnedLoc, candidate.directOwnedLoc),
      ownershipLocDenominator: Math.max(existing.ownershipLocDenominator, candidate.ownershipLocDenominator),
    });
  }

  return [...byLogin.values()];
}

export function buildCandidatePool(input: BuildCandidatePoolInput): BuildCandidatePoolResult {
  const codeownersCandidates = dedupeCandidates(applyFilters(computeCodeownersCandidates(input), input.filters));

  if (input.codeownersPresent && codeownersCandidates.length > 0) {
    return {
      candidates: codeownersCandidates,
      usedSignalFallback: false,
    };
  }

  const signalCandidates = dedupeCandidates(applyFilters(buildSignalSeedCandidates(input.signalSeeds), input.filters));

  return {
    candidates: signalCandidates,
    usedSignalFallback: true,
  };
}

function clampPositive(value: number, max: number): number {
  return Math.max(0, Math.min(value, max));
}

function ownershipTierScore(tier: OwnershipTier, weights: ScoreWeights): number {
  switch (tier) {
    case 'direct_gte50':
      return weights.weightDirectGte50;
    case 'direct_gte20':
      return weights.weightDirectGte20;
    case 'direct_floor':
      return weights.weightDirectFloor;
    case 'team_any':
      return weights.weightTeamAny;
    case 'fallback_any':
      return weights.weightFallbackAny;
    case 'none':
      return 0;
  }
}

function getSignalsForLogin(
  signalsByLogin: Record<string, CandidateSignalStats>,
  login: string,
): CandidateSignalStats {
  return (
    signalsByLogin[login] ?? {
      commitCount: 0,
      reviewCount: 0,
      openAssignedPrs: 0,
      pendingReviewRequests: 0,
      recentAssignments: 0,
    }
  );
}

export function rankCandidates(input: RankCandidatesInput): RankCandidatesResult {
  const ranking = input.candidates
    .map((candidate): RankedCandidate => {
      const signals = getSignalsForLogin(input.signalsByLogin, candidate.login);
      const components: CandidateScoreComponents = {
        direct_ownership: ownershipTierScore(candidate.tier, input.weights),
        code_familiarity: clampPositive(
          signals.commitCount * input.weights.weightCodeFamiliarityPerCommit,
          input.weights.weightCodeFamiliarityMax,
        ),
        review_familiarity: clampPositive(
          signals.reviewCount * input.weights.weightReviewFamiliarityPerReview,
          input.weights.weightReviewFamiliarityMax,
        ),
        active_load: clampPositive(
          signals.openAssignedPrs * input.weights.weightActiveLoadPerPr,
          input.weights.weightActiveLoadMax,
        ),
        pending_review: clampPositive(
          signals.pendingReviewRequests * input.weights.weightPendingReviewPerRequest,
          input.weights.weightPendingReviewMax,
        ),
        recent_assignment: clampPositive(
          signals.recentAssignments * input.weights.weightRecentAssignmentPerPr,
          input.weights.weightRecentAssignmentMax,
        ),
        team_fallback: candidate.tier === 'team_any' ? input.weights.weightTeamFallbackPenalty : 0,
        fallback_only: candidate.tier === 'fallback_any' ? input.weights.weightFallbackOnlyPenalty : 0,
      };

      const total =
        components.direct_ownership +
        components.code_familiarity +
        components.review_familiarity -
        components.active_load -
        components.pending_review -
        components.recent_assignment -
        components.team_fallback -
        components.fallback_only;

      return {
        login: candidate.login,
        total,
        tier: candidate.tier,
        components,
      };
    })
    .sort((a, b) => {
      if (a.total !== b.total) return b.total - a.total;
      if (tierRank[a.tier] !== tierRank[b.tier]) return tierRank[b.tier] - tierRank[a.tier];
      if (a.components.active_load !== b.components.active_load) {
        return a.components.active_load - b.components.active_load;
      }
      if (a.components.recent_assignment !== b.components.recent_assignment) {
        return a.components.recent_assignment - b.components.recent_assignment;
      }
      if (a.components.code_familiarity !== b.components.code_familiarity) {
        return b.components.code_familiarity - a.components.code_familiarity;
      }
      return a.login.localeCompare(b.login);
    });

  const winner = ranking.find((candidate) => candidate.total > 0);
  if (!winner) {
    throw new Error(
      'all candidates have non-positive scores; workload penalties dominated ownership - consider adjusting weights.',
    );
  }

  return {
    ranking,
    assignee: winner.login,
  };
}
