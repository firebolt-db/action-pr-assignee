import * as core from '@actions/core';
import { writeOutputs } from './output.js';
import { runAction } from './orchestrator/runAction.js';

async function main(): Promise<void> {
  try {
    const result = await runAction();
    writeOutputs(result);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

void main();
