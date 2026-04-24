import * as core from '@actions/core';
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
