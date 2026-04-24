export type SkippedReason =
  | ''
  | 'draft'
  | 'already_assigned'
  | 'opted_out'
  | 'fork_pr'
  | 'empty_candidate_pool';

export interface ActionOutputs {
  proposedAssignee: string;
  assignmentPerformed: boolean;
  rankedCandidatesJson: string;
  explanation: string;
  skippedReason: SkippedReason;
}

export interface ActionRunResult extends ActionOutputs {}
