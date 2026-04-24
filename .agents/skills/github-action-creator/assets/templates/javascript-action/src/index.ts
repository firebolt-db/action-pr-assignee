import * as core from '@actions/core';

async function run(): Promise<void> {
  try {
    const greeting = core.getInput('greeting') || 'Hello';
    const whoToGreet = core.getInput('who-to-greet', { required: true });

    const fullGreeting = `${greeting}, ${whoToGreet}!`;
    core.info(fullGreeting);
    core.setOutput('full-greeting', fullGreeting);
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

run();
