# PR Assignee

Deterministically selects and assigns exactly one best assignee for each pull request using CODEOWNERS, familiarity, and workload signals.

Specification source of truth: [docs/SPEC.md](docs/SPEC.md).

## Why This Action

- Deterministic and explainable decisioning (no AI/LLM routing).
- Single-assignee policy to avoid diffusion of ownership.
- GraphQL-first data collection with graceful degradation on optional signals.
- Works with or without CODEOWNERS.

## Usage

```yaml
name: PR Assignee

on:
  pull_request:
    types: [opened, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: pr-assignee-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  assign:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: firebolt-db/action-pr-assignee@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          dry_run: "false"
```

## Inputs

### Tokens

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `github_token` | yes | none | Token with `contents:read` and `pull-requests:write` or `issues:write`. |
| `token_override` | no | `""` | Optional token for org/team expansion (`members:read`) and status OOO (`read:user`). |

### Execution

| Input | Default |
| --- | --- |
| `dry_run` | `false` |
| `opt_out_label` | `no-auto-assign` |

### Window Inputs

| Input | Default |
| --- | --- |
| `familiarity_window_days` | `30` |
| `review_window_days` | `30` |
| `recent_assignment_window_days` | `10` |
| `activity_window_days` | `30` |

### Feature / Filter Inputs

| Input | Default |
| --- | --- |
| `check_github_status` | `true` |
| `exclude_users` | empty |
| `bot_login_patterns` | `\[bot\]$`, `^dependabot$`, `^renovate$` |
| `fallback_patterns` | `^\*$`, `^/$` |
| `unavailable_reviewers` | empty |

### Score Weight Inputs

All scoring knobs listed in [docs/SPEC.md](docs/SPEC.md) section 6.6 are exposed as action inputs with defaults.

## Outputs

| Output | Description |
| --- | --- |
| `proposed_assignee` | Selected login, empty when skipped. |
| `assignment_performed` | `"true"` when assignment mutation succeeds. |
| `ranked_candidates_json` | Ranked candidate list with score component breakdown. |
| `explanation` | Human-readable summary of winner and runner-up. |
| `skipped_reason` | `""`, `draft`, `already_assigned`, `opted_out`, `fork_pr`, `empty_candidate_pool`. |

## Important Behavior

- Never overwrites existing assignees.
- Never modifies labels, title/body, or requested reviewers.
- Skips fork PRs (`pull_request` read-only token context).
- Dry-run executes the full decision path but suppresses assignment mutation.

## Security Notes

- Do not use this action with `pull_request_target`.
- For sensitive repositories, pin by full commit SHA:

```yaml
- uses: firebolt-db/action-pr-assignee@<full-commit-sha>
```

- Keep SHA pins fresh with Dependabot or equivalent.

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```
