---
name: github-action-creator
description: Author, release, and publish reusable GitHub Actions — including Docker container, JavaScript/TypeScript, and composite actions. Use this skill whenever the user wants to build a custom GitHub Action, author or edit an `action.yml`/`action.yaml`, wrap a CLI as a reusable action (`setup-$TOOL` pattern), handle action exit codes and failure behavior, tag and release an action with semantic versions, move or pin major-version tags (`v1`, `v2`), adopt immutable releases, publish to the GitHub Marketplace, or maintain an action over time. Trigger even when the user only implies action authoring — e.g. "I want to wrap our CLI so other repos can call it from workflows", "turn this script into something reusable in CI", "how do we share this step across repos", "set up a release pipeline for our action", "is our action's v1 tag moving correctly".
---

# GitHub Action Creator

A skill for creating, releasing, and maintaining custom GitHub Actions end-to-end. Covers the three official action types, the full `action.yml` metadata schema, CLI/setup-tool actions, exit-code semantics, semver tagging strategy, immutable releases, and publishing to the GitHub Marketplace.

## When to reach for this skill

Reach for it when the user is **authoring or operating an action**, not when they are **consuming** one inside a workflow. If they are writing `uses: actions/checkout@v6` in a workflow file, that is workflow authoring, not action authoring — this skill is the wrong fit. If they are creating the thing other workflows will `use:`, this skill applies.

## High-level workflow

An action goes through four phases. Do not skip phases — missing metadata or tag hygiene is the single most common reason actions break for downstream consumers.

1. **Pick the action type.** Docker container, JavaScript, or composite. The decision shapes the whole repo layout; getting it wrong costs a rewrite. See `references/action-types.md`.
2. **Author the metadata + implementation.** `action.yml` at the repo root, plus the handler (`entrypoint.sh` / `index.js` / `steps:`). See `references/action-metadata.md` for the full schema and `assets/templates/` for working scaffolds.
3. **Handle success and failure explicitly.** Exit codes determine whether downstream steps run. See `references/exit-codes.md`.
4. **Release and (optionally) publish.** Tag with semver, move major tags, decide on immutable releases, optionally list on the Marketplace. See `references/release-and-maintain.md`, `references/immutable-releases.md`, and `references/publish-marketplace.md`.

## Phase 1 — Pick the action type

Only three types exist. Pick once, consciously:

| Type            | Best when                                                                                        | Costs                                                          |
|-----------------|--------------------------------------------------------------------------------------------------|----------------------------------------------------------------|
| **Docker**      | The action needs specific system tooling, a non-Node runtime, or full OS control.                | Linux runners only. Slow cold start (image build/pull).        |
| **JavaScript**  | Fast startup, cross-OS (Linux/macOS/Windows), `@actions/core` + `@actions/toolkit`. Author in TypeScript, bundle with Bun. | Must ship bundled `dist/index.js` or consumers pull your `node_modules`. |
| **Composite**   | Your logic is "run these shell commands / call these existing actions in sequence."              | No direct JS handler; debugging is via shell only.             |

If the user says "wrap a CLI" or "install tool X on the runner," this is almost always a **JavaScript** action using `@actions/tool-cache` (the `setup-$TOOL` pattern). See `references/cli-action.md`.

If the user says "just run these shell commands" and the logic fits in a few `run:` steps, push toward **composite** — it is the lowest-overhead choice and does not require a build step.

Default to **Docker** only when there is a concrete reason (system package, non-Node runtime, isolation requirement). Document the reason in the README so future maintainers don't wonder why.

## Phase 2 — Author the metadata and implementation

### Location rules

- For a **shared/public** action: the action lives in its **own repository**, with `action.yml` at the repo root. This enables semver tags, Marketplace listing, and clean versioning.
- For a **private/internal** action used only inside one repo: place it under `.github/actions/<action-name>/action.yml`. Multiple internal actions can coexist this way.

`action.yml` and `action.yaml` are both accepted; pick one per repo and stick with it.

### Metadata essentials

Every `action.yml` has the same top-level shape:

```yaml
name: 'My Action'          # required; must be Marketplace-unique if publishing
author: 'Firebolt'         # optional
description: 'What it does' # required
inputs: { ... }            # optional map
outputs: { ... }           # optional map
runs: { ... }              # required; shape depends on action type
branding: { icon: ..., color: ... }  # required only for Marketplace publishing
```

For the full schema (every field, every action type's `runs:` block, branding icon/color allowed values, composite output syntax, pre/post hooks), read `references/action-metadata.md`.

### Scaffolds

Use the templates under `assets/templates/` as the starting point — they are the smallest working example for each type:

- `assets/templates/docker-action/` — `action.yml`, `Dockerfile`, `entrypoint.sh`
- `assets/templates/javascript-action/` — `action.yml`, `package.json`, `tsconfig.json`, `src/index.ts` (bundled to `dist/index.js` with Bun)
- `assets/templates/composite-action/` — `action.yml` with a composite `steps:` block

Copy the template into the target repo, then edit. Do not invent scaffolds from scratch — missing fields (especially `runs.using`, input `description`, and branding for Marketplace) are the top source of "my action won't load" bugs.

### Cross-platform hygiene

Never hardcode `https://api.github.com` or `https://api.github.com/graphql`. GitHub Enterprise Server consumers will break. Use:

- `process.env.GITHUB_API_URL` for REST
- `process.env.GITHUB_GRAPHQL_URL` for GraphQL
- Or the `@actions/github` toolkit, which wires these automatically.

JavaScript actions should declare `using: node20` (or `node24` when available) — older Node versions are deprecated on a rolling schedule.

## Phase 3 — Exit codes and failure

The runner reads the process exit code to decide whether the step passed. `0` = success, any nonzero = failure. A failed step halts the workflow job by default and skips dependent steps.

- **JavaScript**: call `core.setFailed(error.message)` from `@actions/core` — it both logs the error and sets exit code 1.
- **Docker**: `exit 1` (or any nonzero) from `entrypoint.sh`.
- **Composite**: if any `run:` step exits nonzero, the composite action fails — unless the step opts out with `continue-on-error: true`.

Full treatment (neutral exit codes, partial failure patterns, how to fail loudly vs. warn) is in `references/exit-codes.md`.

## Phase 4 — Release and publish

### Semver + moving major tags

The ecosystem convention is:

- Tag each release with a **full semver** tag: `v1.2.3`.
- Maintain a **moving major tag**: `v1` that always points at the latest `v1.x.y` commit. Consumers pin `@v1` to get non-breaking updates automatically.
- Optionally maintain a **moving minor tag**: `v1.2` for users who want patch updates only.
- When shipping a breaking change, cut `v2` as a new major tag.

To move a major tag after a new release:

```bash
git tag -f v1 v1.2.3
git push -f origin v1
```

Security-conscious consumers pin to a full commit SHA (`uses: org/action@<40-char-sha>`) — this is now the recommended default for Firebolt-internal workflows per security review.

See `references/release-and-maintain.md` for release automation workflows (CI on push, release workflow on `release.published`, tools like `JasonEtco/build-and-tag-action`).

### Immutable releases

GitHub supports marking releases as **immutable** so their tag cannot be retargeted after publication. This trades the convenience of moving tags for supply-chain guarantees. When immutable releases are enabled, the moving `v1` pattern still works for **Git tags you didn't turn into GitHub Releases** — create the release at `v1.2.3` (immutable), but keep `v1` as a plain Git tag you can force-push. See `references/immutable-releases.md` for the full interplay.

### Marketplace publishing

Publishing to the Marketplace has hard requirements:

- The repo must be **public**.
- Exactly **one** `action.yml`/`action.yaml` at the repo **root**.
- **No workflow files** in the repo (`.github/workflows/*.yml` — these will block Marketplace auto-listing in older flows; modern publishing still requires the metadata to validate cleanly).
- `name:` must be **unique across the Marketplace** and not collide with reserved GitHub names, usernames, or categories.
- `branding.icon` and `branding.color` are **required** and drive the Marketplace card.

Full acceptance checklist, category selection, removal, and verified-creator badging in `references/publish-marketplace.md`.

## Interviewing the user

Before writing code, lock down:

1. **Type**: Docker, JavaScript, or composite? (Drive the answer with the decision table above — don't just ask the user to pick.)
2. **Inputs/outputs**: names, types, required flags, defaults.
3. **Runtime**: for JS, which Node version? for Docker, base image?
4. **Distribution**: private/internal (lives in `.github/actions/`) or public (own repo + Marketplace)?
5. **Release cadence**: is there an existing `v1`? Are they adopting immutable releases?

Capture the answers inline, then scaffold from `assets/templates/`, then fill in.

## Reference files

Read these on demand — they are detailed but narrow:

- `references/action-types.md` — Full comparison of Docker vs JavaScript vs composite, with directory layouts for each.
- `references/action-metadata.md` — Complete `action.yml` schema: every field, every `runs:` variant, branding icon/color allowed values, pre/post hooks, composite output syntax.
- `references/cli-action.md` — The `setup-$TOOL` pattern: download, extract, cache, add to PATH. Covers `@actions/tool-cache` usage and multi-OS support.
- `references/exit-codes.md` — Exit code semantics for each action type, `core.setFailed` vs `core.setOutput` vs `throw`, neutral exit codes, continue-on-error.
- `references/release-and-maintain.md` — Semver tagging, moving major/minor tags, CI + release workflows, bundled `dist/` handling, branching strategy.
- `references/immutable-releases.md` — Immutable releases: what they are, how they interact with moving tags, migration steps.
- `references/publish-marketplace.md` — Marketplace prerequisites, publishing flow, categories, removal, verified creator badge.

## Templates (under `assets/templates/`)

Starting points — copy, then edit. Every template is minimal-but-valid: it will load and run as-is.

- `docker-action/` — Dockerfile + entrypoint.sh + action.yml
- `javascript-action/` — TypeScript source (`src/index.ts`) + `tsconfig.json` + `package.json` + `action.yml`; bundled to `dist/index.js` with `bun build --target=node`
- `composite-action/` — action.yml only

## Common failure modes

Things that waste a user's afternoon and are worth naming up front:

- **`action.yml` not at the repo root** for a public action → nothing resolves the action.
- **Missing `description:` on an input** → validation error, action won't load.
- **Bundled `dist/` out of sync** for a JavaScript action → users pinned to `@v1` get old code even after a fresh release. Automate the bundle step in a release workflow.
- **`v1` tag not moved** after a new `v1.x.y` release → consumers pinned to `@v1` silently miss the update. Enforce with a release workflow.
- **`node16` in `runs.using:`** → deprecated; will warn now and break later. Use `node20` or newer.
- **Publishing to Marketplace from a repo that contains workflow files** → will be rejected on auto-listing. Move workflows out of a Marketplace-published repo, or keep CI in a separate repo.
- **Hardcoded `api.github.com`** → breaks on GitHub Enterprise Server. Use `GITHUB_API_URL`.

When a user reports one of these, check it first before digging deeper.
