# AGENTS.md — `test/`

Bun-driven tests. The architecture (SPEC §4) exists so this directory can fully verify behavior without touching GitHub.

## Layout

```
test/
  adapters/github/    Adapter-level unit tests with an OctokitLike fake.
  cache/              Activity-cache save/restore with an injected cache provider.
  config/             parseActionConfig unit tests (input validation, redaction).
  engine/             Pure-engine unit tests (pool building, ranking, tie-breaks).
  fixtures/           Committed fixture files — no inline JSON blobs in test sources.
    integration/scenarios.json   Scenario matrix driving `integration/scenarios.test.ts`.
  integration/        Engine-driven scenario runner over the fixture matrix.
  orchestrator/       Wired-up `runAction` tests with injected deps + end-to-end codeowners resolver test.
  output.test.ts      `formatExplanation` output shape test.
```

## Rules

1. **No live GitHub.** The default test run must succeed with no network. If a test needs an Octokit-like object, supply an `OctokitLike` fake. If a live-integration harness is added in the future, it must be gated behind an opt-in env var and must not run in CI.
2. **No inline JSON blobs.** GraphQL responses, event payloads, and CODEOWNERS contents belong in `test/fixtures/`. Scenario tests iterate over JSON files.
3. **Every scoring component has direct coverage.** Formulas, clamps, and tie-break rules are tested in `test/engine/ranking.test.ts` against golden totals.
4. **Every required integration scenario exists as a fixture.** The list lives in SPEC §19.2 — keep `scenarios.json` aligned when scenarios are added, removed, or renamed.
5. **Fakes over mocks.** `OctokitLike` is small enough to implement inline per test. Resist pulling in a mocking library; the handwritten fake makes the contract visible.
6. **No hidden clock dependency.** When a test needs time, pass an ISO string explicitly. The engine has no clock; adapters take `since` as a parameter.

## Running

```bash
bun test                 # all tests
bun test test/engine     # a single directory
bun test --watch         # re-run on file changes (local dev)
```

## Adding a test

- Engine behavior → `test/engine/<subject>.test.ts`. Prefer golden tables for scoring changes.
- New adapter → `test/adapters/github/<file>.test.ts`. Drive it entirely through an `OctokitLike` fake.
- New early-exit reason → add a fixture row to `scenarios.json` and an assertion in `integration/scenarios.test.ts`; also add an orchestrator-level case in `orchestrator/runAction.integration.test.ts` if the exit interacts with adapters.
- New input parsing rule → `test/config/parseConfig.test.ts`. Cover both the valid and invalid-input paths.

## Known issues

_None recorded yet._
