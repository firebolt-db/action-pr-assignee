import { describe, expect, it } from 'bun:test';
import { parseActionConfig } from '../../src/config/parseConfig.js';

function makeRawInputs(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    github_token: 'ghs_primary',
    token_override: '',
    dry_run: 'false',
    opt_out_label: 'no-auto-assign',
    familiarity_window_days: '30',
    review_window_days: '30',
    recent_assignment_window_days: '10',
    activity_window_days: '30',
    check_github_status: 'true',
    exclude_users: '',
    bot_login_patterns: '\\[bot\\]$\n^dependabot$\n^renovate$',
    fallback_patterns: '^\\*$\n^/$',
    unavailable_reviewers: '',
    weight_direct_gte50: '50',
    weight_direct_gte20: '35',
    weight_direct_floor: '20',
    weight_team_any: '20',
    weight_fallback_any: '5',
    weight_code_familiarity_per_commit: '5',
    weight_code_familiarity_max: '25',
    weight_review_familiarity_per_review: '4',
    weight_review_familiarity_max: '20',
    weight_active_load_per_pr: '8',
    weight_active_load_max: '24',
    weight_pending_review_per_request: '5',
    weight_pending_review_max: '20',
    weight_recent_assignment_per_pr: '6',
    weight_recent_assignment_max: '18',
    weight_team_fallback_penalty: '10',
    weight_fallback_only_penalty: '20',
    ...overrides,
  };
}

function makeSource(overrides: Record<string, string> = {}) {
  const rawInputs = makeRawInputs(overrides);

  return {
    getInput(name: string, options?: { required?: boolean }): string {
      const value = rawInputs[name] ?? '';
      if (options?.required && value.trim().length === 0) {
        throw new Error(`Input required and not supplied: ${name}`);
      }

      return value;
    },
    getBooleanInput(name: string): boolean {
      const raw = this.getInput(name).toLowerCase();
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new Error(`Boolean input expected for ${name}, got "${raw}"`);
    },
    debug(_message: string): void {},
  };
}

function makeSourceWithDebugCollector(overrides: Record<string, string> = {}) {
  const messages: string[] = [];
  const source = makeSource(overrides);

  return {
    source: {
      ...source,
      debug(message: string): void {
        messages.push(message);
      },
    },
    messages,
  };
}

describe('parseActionConfig', () => {
  it('parses valid defaults', () => {
    const config = parseActionConfig(makeSource());

    expect(config.githubToken).toBe('ghs_primary');
    expect(config.effectiveToken).toBe('ghs_primary');
    expect(config.dryRun).toBe(false);
    expect(config.signalWindows.familiarityWindowDays).toBe(30);
    expect(config.scoreWeights.weightDirectGte50).toBe(50);
    expect(config.botLoginPatterns).toHaveLength(3);
    expect(config.fallbackPatterns).toHaveLength(2);
  });

  it('uses token override when provided', () => {
    const config = parseActionConfig(makeSource({ token_override: 'ghs_override' }));

    expect(config.effectiveToken).toBe('ghs_override');
  });

  it('parses list inputs and ignores comments', () => {
    const config = parseActionConfig(
      makeSource({
        exclude_users: 'alice\n# comment\nbob',
        unavailable_reviewers: 'carol',
      }),
    );

    expect(config.excludeUsers).toEqual(['alice', 'bob']);
    expect(config.unavailableReviewers).toEqual(['carol']);
  });

  it('throws for malformed integer input', () => {
    expect(() =>
      parseActionConfig(
        makeSource({
          weight_direct_gte50: 'NaN',
        }),
      ),
    ).toThrow('weight_direct_gte50');
  });

  it('throws for partially numeric integer input', () => {
    expect(() =>
      parseActionConfig(
        makeSource({
          activity_window_days: '30days',
        }),
      ),
    ).toThrow('activity_window_days');
  });

  it('throws for negative window input', () => {
    expect(() =>
      parseActionConfig(
        makeSource({
          activity_window_days: '-1',
        }),
      ),
    ).toThrow('activity_window_days');
  });

  it('throws for invalid regex pattern', () => {
    expect(() =>
      parseActionConfig(
        makeSource({
          bot_login_patterns: '[',
        }),
      ),
    ).toThrow('bot_login_patterns');
  });

  it('redacts token values in debug output', () => {
    const { source, messages } = makeSourceWithDebugCollector({
      github_token: 'ghs_secret_primary',
      token_override: 'ghs_secret_override',
    });

    parseActionConfig(source);

    const debugLog = messages.join('\n');
    expect(debugLog).toContain('[REDACTED]');
    expect(debugLog).not.toContain('ghs_secret_primary');
    expect(debugLog).not.toContain('ghs_secret_override');
  });
});
