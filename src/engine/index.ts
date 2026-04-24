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
