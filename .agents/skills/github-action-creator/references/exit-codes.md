# Exit Codes and Failure Semantics

The runner decides whether a step passed or failed by inspecting the **process exit code**: `0` means success, any non-zero value means failure. A failed step fails the job by default, which skips any dependent steps and jobs. This reference covers how each action type surfaces exit codes and the patterns for signaling success, warning, and failure cleanly.

## Core rules

- `exit 0` → step passes, dependent steps run.
- `exit <non-zero>` → step fails, the job fails, dependent steps are skipped.
- A step that fails does **not** cancel other steps in the same job that are already running in parallel — but GitHub Actions doesn't run steps in parallel within a job (steps are sequential), so this mostly matters across jobs.
- The step's own `continue-on-error: true` (in the workflow consuming the action) overrides failure propagation for that step.

## By action type

### JavaScript

Use `core.setFailed` from `@actions/core`. It both logs the message with the `::error::` workflow command (so GitHub surfaces it in the UI) and sets `process.exitCode = 1`:

```javascript
const core = require('@actions/core');

async function run() {
  try {
    // ... action logic
  } catch (err) {
    core.setFailed(err.message);
  }
}

run();
```

**Don't** call `process.exit(1)` directly — it short-circuits Node's pending I/O (unflushed logs, pending `post` steps) and you lose diagnostic output. `core.setFailed` sets `process.exitCode`, which lets Node exit cleanly after the current tick.

**Don't** `throw` from the top level. An unhandled promise rejection still prints a stack trace but the behavior around exit code has varied across Node versions. Always wrap `run()` in try/catch.

For warnings that shouldn't fail the step:

```javascript
core.warning('This thing is deprecated and will stop working in v2.');
// step still passes
```

For annotations that show inline on PR files:

```javascript
core.warning('Use constant-time comparison here.', {
  file: 'src/auth.js',
  startLine: 42,
});
core.error('This is unsafe.', {
  file: 'src/auth.js',
  startLine: 99,
  title: 'SQL injection risk',
});
```

`core.error` does **not** by itself fail the step — it only adds an error annotation. Combine with `core.setFailed` if you want the step to fail.

### Docker container

Set the exit code from your entrypoint script. Bash:

```bash
#!/bin/sh
set -e   # fail on any command error — common default

if [ -z "$INPUT_TOKEN" ]; then
  echo "::error::Input 'token' is required"
  exit 1
fi

if ! do_the_thing; then
  echo "::error::do_the_thing failed"
  exit 1
fi

echo "::notice::Done"
exit 0
```

The `set -e` at the top is a safety net — without it, a failing intermediate command leaves the script to continue and the step exits 0 when it shouldn't.

**Writing outputs before exiting failure**: outputs still propagate even from a failing step, as long as you've written them to `$GITHUB_OUTPUT` before the non-zero exit. Useful for partial results the caller wants to inspect:

```bash
echo "partial-result=$DATA" >> "$GITHUB_OUTPUT"
exit 1
```

### Composite

A composite action fails when **any of its steps fails** (unless that step has `continue-on-error: true`). You don't set an exit code directly — the step's exit code bubbles up.

```yaml
runs:
  using: 'composite'
  steps:
    - name: This must succeed
      run: ./must-succeed.sh
      shell: bash

    - name: This is best-effort
      run: ./best-effort.sh
      shell: bash
      continue-on-error: true     # composite still passes even if this fails

    - name: Check result
      if: always()                # run even if an earlier step failed
      run: ./cleanup.sh
      shell: bash
```

Note: `continue-on-error` inside a composite applies to the individual step within the composite. It does **not** prevent the composite action itself from failing when called from a workflow — that is controlled by the workflow author via `continue-on-error` on the `uses:` step.

## Workflow commands for annotations

These are the `echo`-based workflow commands that work in any action type:

```bash
echo "::error file=src/app.js,line=42::Message here"
echo "::warning::Non-fatal thing"
echo "::notice file=README.md,line=1::FYI"
echo "::debug::Only shown when ACTIONS_STEP_DEBUG=true"
```

All four are fire-and-forget — they do **not** set the exit code. Pair `::error::` with a non-zero exit when you actually want the step to fail.

## Grouping log output

Useful for long-running actions whose logs you want collapsible in the UI:

```bash
echo "::group::Downloading"
# ... noisy output
echo "::endgroup::"
```

## Masking secrets

If your action receives a secret as an input and then echoes it (deliberately or by accident), mask it explicitly:

```bash
echo "::add-mask::$TOKEN"
```

After masking, any future occurrence of that string in the logs is replaced with `***`. Do this **before** any command that might print the value.

## Patterns

### Fail loudly on invalid input

```javascript
const token = core.getInput('token', { required: true });
if (!token) {
  core.setFailed('Input `token` is required.');
  return;
}
```

Validate early. It is much more useful to fail in the first 100ms of the action than 30 seconds in after a useless network call.

### Succeed with a warning instead of failing

When the action's core task is done but something optional didn't work:

```javascript
try {
  await optionalTelemetryPing();
} catch (err) {
  core.warning(`Telemetry ping failed: ${err.message}`);
  // deliberately do not re-throw
}
```

### Partial success

Emit outputs describing what succeeded and what didn't, and let the workflow decide:

```javascript
core.setOutput('succeeded', JSON.stringify(successful));
core.setOutput('failed', JSON.stringify(failed));
if (failed.length > 0) {
  core.setFailed(`${failed.length} items failed.`);
}
```

Then the workflow can key off `steps.my-action.outputs.failed` before the step-level failure stops it.

## Anti-patterns

- **`process.exit(1)` in JS actions.** See above — flushing / cleanup gets cut off.
- **`exit 0` from `entrypoint.sh` after a failed command** (forgetting `set -e`). Use `set -e` or explicitly check return codes.
- **`core.error` without `core.setFailed`.** Produces an error annotation but passes the step. Confusing to debug.
- **Swallowing every exception unconditionally.** If the try/catch in the JS handler is `catch (e) { /* nothing */ }`, the step always passes even when broken. Either re-throw or call `core.setFailed`.
