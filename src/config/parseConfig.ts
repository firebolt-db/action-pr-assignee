import type { ActionConfig } from './types.js';

interface InputSource {
  getInput(name: string, options?: { required?: boolean }): string;
  getBooleanInput(name: string): boolean;
  debug(message: string): void;
}

function parseIntInput(inputName: string, raw: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`Invalid input: ${inputName} must be an integer, got "${raw}"`);
  }

  return value;
}

function parseWindowInput(inputName: string, raw: string): number {
  const value = parseIntInput(inputName, raw);
  if (value < 0) {
    throw new Error(`Invalid input: ${inputName} must be >= 0, got "${raw}"`);
  }

  return value;
}

function parseListInput(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function parseRegexList(inputName: string, raw: string): RegExp[] {
  const patterns = parseListInput(raw);
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern, 'i');
    } catch {
      throw new Error(`Invalid input: ${inputName} contains invalid regex "${pattern}"`);
    }
  });
}

export function parseActionConfig(inputs: InputSource): ActionConfig {
  const githubToken = inputs.getInput('github_token', { required: true });
  const tokenOverride = inputs.getInput('token_override').trim();
  const effectiveToken = tokenOverride || githubToken;

  const dryRun = inputs.getBooleanInput('dry_run');
  const checkGitHubStatus = inputs.getBooleanInput('check_github_status');
  const optOutLabel = inputs.getInput('opt_out_label').trim();

  const config: ActionConfig = {
    githubToken,
    tokenOverride,
    effectiveToken,
    dryRun,
    optOutLabel,
    checkGitHubStatus,
    excludeUsers: parseListInput(inputs.getInput('exclude_users')).map((login) => login.toLowerCase()),
    unavailableReviewers: parseListInput(inputs.getInput('unavailable_reviewers')).map((login) =>
      login.toLowerCase(),
    ),
    botLoginPatterns: parseRegexList('bot_login_patterns', inputs.getInput('bot_login_patterns')),
    fallbackPatterns: parseRegexList('fallback_patterns', inputs.getInput('fallback_patterns')),
    signalWindows: {
      familiarityWindowDays: parseWindowInput('familiarity_window_days', inputs.getInput('familiarity_window_days')),
      reviewWindowDays: parseWindowInput('review_window_days', inputs.getInput('review_window_days')),
      recentAssignmentWindowDays: parseWindowInput(
        'recent_assignment_window_days',
        inputs.getInput('recent_assignment_window_days'),
      ),
      activityWindowDays: parseWindowInput('activity_window_days', inputs.getInput('activity_window_days')),
    },
    scoreWeights: {
      weightDirectGte50: parseIntInput('weight_direct_gte50', inputs.getInput('weight_direct_gte50')),
      weightDirectGte20: parseIntInput('weight_direct_gte20', inputs.getInput('weight_direct_gte20')),
      weightDirectFloor: parseIntInput('weight_direct_floor', inputs.getInput('weight_direct_floor')),
      weightTeamAny: parseIntInput('weight_team_any', inputs.getInput('weight_team_any')),
      weightFallbackAny: parseIntInput('weight_fallback_any', inputs.getInput('weight_fallback_any')),
      weightCodeFamiliarityPerCommit: parseIntInput(
        'weight_code_familiarity_per_commit',
        inputs.getInput('weight_code_familiarity_per_commit'),
      ),
      weightCodeFamiliarityMax: parseIntInput('weight_code_familiarity_max', inputs.getInput('weight_code_familiarity_max')),
      weightReviewFamiliarityPerReview: parseIntInput(
        'weight_review_familiarity_per_review',
        inputs.getInput('weight_review_familiarity_per_review'),
      ),
      weightReviewFamiliarityMax: parseIntInput(
        'weight_review_familiarity_max',
        inputs.getInput('weight_review_familiarity_max'),
      ),
      weightActiveLoadPerPr: parseIntInput('weight_active_load_per_pr', inputs.getInput('weight_active_load_per_pr')),
      weightActiveLoadMax: parseIntInput('weight_active_load_max', inputs.getInput('weight_active_load_max')),
      weightPendingReviewPerRequest: parseIntInput(
        'weight_pending_review_per_request',
        inputs.getInput('weight_pending_review_per_request'),
      ),
      weightPendingReviewMax: parseIntInput(
        'weight_pending_review_max',
        inputs.getInput('weight_pending_review_max'),
      ),
      weightRecentAssignmentPerPr: parseIntInput(
        'weight_recent_assignment_per_pr',
        inputs.getInput('weight_recent_assignment_per_pr'),
      ),
      weightRecentAssignmentMax: parseIntInput(
        'weight_recent_assignment_max',
        inputs.getInput('weight_recent_assignment_max'),
      ),
      weightTeamFallbackPenalty: parseIntInput(
        'weight_team_fallback_penalty',
        inputs.getInput('weight_team_fallback_penalty'),
      ),
      weightFallbackOnlyPenalty: parseIntInput(
        'weight_fallback_only_penalty',
        inputs.getInput('weight_fallback_only_penalty'),
      ),
    },
  };

  inputs.debug(`Resolved config: ${JSON.stringify(config)}`);

  return config;
}
