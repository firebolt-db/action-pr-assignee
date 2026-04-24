import { describe, expect, it } from 'bun:test';
import { formatExplanation } from '../src/output.js';
import type { RankedCandidate } from '../src/engine/index.js';

describe('formatExplanation', () => {
  it('formats winner and runner-up details', () => {
    const ranked: RankedCandidate[] = [
      {
        login: 'alice',
        total: 55,
        tier: 'direct_gte50',
        components: {
          direct_ownership: 50,
          code_familiarity: 20,
          review_familiarity: 12,
          active_load: 16,
          pending_review: 5,
          recent_assignment: 6,
          team_fallback: 0,
          fallback_only: 0,
        },
      },
      {
        login: 'bob',
        total: 15,
        tier: 'team_any',
        components: {
          direct_ownership: 20,
          code_familiarity: 5,
          review_familiarity: 0,
          active_load: 0,
          pending_review: 0,
          recent_assignment: 0,
          team_fallback: 10,
          fallback_only: 0,
        },
      },
    ];

    const explanation = formatExplanation(ranked);

    expect(explanation).toContain('alice - total 55');
    expect(explanation).toContain('runner-up: bob (15)');
    expect(explanation).toContain('active load: -16');
  });

  it('returns empty explanation for empty ranking', () => {
    expect(formatExplanation([])).toBe('');
  });
});
