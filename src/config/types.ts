export interface SignalWindows {
  familiarityWindowDays: number;
  reviewWindowDays: number;
  recentAssignmentWindowDays: number;
  activityWindowDays: number;
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

export interface ActionConfig {
  githubToken: string;
  tokenOverride: string;
  effectiveToken: string;
  dryRun: boolean;
  optOutLabel: string;
  checkGitHubStatus: boolean;
  excludeUsers: string[];
  unavailableReviewers: string[];
  botLoginPatterns: RegExp[];
  fallbackPatterns: RegExp[];
  signalWindows: SignalWindows;
  scoreWeights: ScoreWeights;
}
