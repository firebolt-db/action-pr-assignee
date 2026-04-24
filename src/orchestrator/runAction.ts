import * as core from '@actions/core';
import { createEmptyOutputs } from '../output.js';
import type { ActionRunResult } from '../types.js';

export async function runAction(): Promise<ActionRunResult> {
  const outputs = createEmptyOutputs();

  // Placeholder for the full orchestrator pipeline defined in docs/SPEC.md.
  core.info('PR Assignee action scaffold initialized. Full orchestration will be implemented incrementally.');

  return outputs;
}
