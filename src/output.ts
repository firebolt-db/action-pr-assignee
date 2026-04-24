import * as core from '@actions/core';
import type { ActionConfig } from './config/types.js';
import type { RankedCandidate } from './engine/index.js';
import type { ActionOutputs } from './types.js';

export function createEmptyOutputs(): ActionOutputs {
  return {
    proposedAssignee: '',
    assignmentPerformed: false,
    rankedCandidatesJson: '[]',
    explanation: '',
    skippedReason: '',
  };
}

export function writeOutputs(outputs: ActionOutputs): void {
  core.setOutput('proposed_assignee', outputs.proposedAssignee);
  core.setOutput('assignment_performed', outputs.assignmentPerformed ? 'true' : 'false');
  core.setOutput('ranked_candidates_json', outputs.rankedCandidatesJson);
  core.setOutput('explanation', outputs.explanation);
  core.setOutput('skipped_reason', outputs.skippedReason);
}

export function formatExplanation(ranked: RankedCandidate[]): string {
  const winner = ranked[0];
  if (!winner) return '';

  const lines = [
    `${winner.login} - total ${winner.total}`,
    `  direct ownership (${winner.tier}): +${winner.components.direct_ownership}`,
    `  code familiarity: +${winner.components.code_familiarity}`,
    `  review familiarity: +${winner.components.review_familiarity}`,
    `  active load: -${winner.components.active_load}`,
    `  pending reviews: -${winner.components.pending_review}`,
    `  recent assignments: -${winner.components.recent_assignment}`,
  ];

  const runnerUp = ranked[1];
  if (runnerUp) {
    lines.push(`runner-up: ${runnerUp.login} (${runnerUp.total})`);
  }

  return lines.join('\n');
}

export async function writeJobSummary(ranked: RankedCandidate[], selectedAssignee: string, config: ActionConfig): Promise<void> {
  const rows = ranked
    .slice(0, 10)
    .map(
      (candidate) =>
        `| ${candidate.login} | ${candidate.total} | ${candidate.tier} | ${candidate.components.direct_ownership} | ${candidate.components.code_familiarity} | ${candidate.components.review_familiarity} | ${candidate.components.active_load} | ${candidate.components.pending_review} | ${candidate.components.recent_assignment} |`,
    )
    .join('\n');

  const markdown = [
    '## PR Assignee Decision',
    '',
    `Selected assignee: \`${selectedAssignee || '(none)'}\``,
    '',
    '| Candidate | Total | Tier | Ownership | Code Familiarity | Review Familiarity | Active Load | Pending Review | Recent Assignment |',
    '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    rows || '| (none) | 0 | none | 0 | 0 | 0 | 0 | 0 | 0 |',
    '',
    '### Resolved Weights',
    '',
    '```json',
    JSON.stringify(config.scoreWeights, null, 2),
    '```',
    '',
  ].join('\n');

  await core.summary.addRaw(markdown, true).write();
}
