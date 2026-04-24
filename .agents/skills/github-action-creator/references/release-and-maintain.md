# Releasing and Maintaining Actions

A GitHub Action is a public API. Once you've tagged `v1`, consumers pin to it and expect it to keep working. Broken releases cost everyone downstream, and "fixing forward" is harder than for a normal library because workflows resolve refs lazily at run time. This reference covers the tagging conventions, release automation, and maintenance discipline that keep an action trustworthy.

## Semver + moving major tags

The ecosystem convention, in three rules:

1. **Every release is tagged with a full semver tag** — `v1.0.0`, `v1.2.3`, `v2.0.0`.
2. **A moving major tag** (`v1`, `v2`) always points at the most recent release of that major version. Consumers pinning `@v1` get non-breaking updates automatically.
3. **Breaking changes bump the major** — cut `v2.0.0`, create a fresh `v2` tag, and leave `v1` pointing at the last `v1.x.y` commit. Both tags coexist: consumers stay on `v1` until they're ready to migrate.

Optionally, also maintain a moving **minor** tag (`v1.2`) for users who want bugfix-only updates. This is nice-to-have, not universal.

### Why "moving major" works

Claiming a tag is immutable would mean every patch release forces every consumer to edit their workflow. Nobody does this. Instead, the moving major tag is the social contract: `v1` will only ever get non-breaking changes; if you want absolute stability, pin to `v1.0.3` or a commit SHA.

## Tag mechanics

### First release of a major

```bash
# On the release commit:
git tag v1.0.0
git tag v1
git push origin v1.0.0 v1
```

### Subsequent patch/minor within `v1`

```bash
# On the new release commit:
git tag v1.0.1
git tag -f v1                # force-update the moving major tag
git push origin v1.0.1
git push -f origin v1        # force-push the moving tag
```

The `-f` on `v1` is necessary and expected — that tag's whole purpose is to move.

### Shipping `v2` with breaking changes

```bash
# v1 stays frozen at whatever it was pointing at.
# Cut v2 from the new commit:
git tag v2.0.0
git tag v2
git push origin v2.0.0 v2
```

Do not delete `v1`. Consumers still on `v1` will keep working. Document the breaking changes in release notes and a `MIGRATION.md`.

### SHA pinning (the security-conscious option)

For consumers who want to eliminate tag-moving risk entirely:

```yaml
- uses: org/action@<40-char-commit-sha>
```

Recommend this pattern to consumers in your README when:

- Your action handles secrets.
- Your action runs in privileged workflows (e.g. `pull_request_target`).
- You're publishing to security-conscious orgs.

Tools like `dependabot` and `stepsecurity/secure-workflows` help consumers keep SHA pins up-to-date.

## Release automation

Two workflows are standard — they live inside the action's repo.

### 1. CI workflow (`.github/workflows/ci.yml`)

Runs unit tests and integration tests on every push and PR.

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun test
      # Self-reference the action to smoke-test the real path consumers take:
      - uses: ./
        with:
          greeting: 'Hello from CI'
```

The `uses: ./` step is important: it resolves the action through the same loader path a consumer uses. If `action.yml` is broken, CI catches it here.

### 2. Release workflow (`.github/workflows/release.yml`)

Runs when a GitHub Release is published or edited. Rebuilds the bundled `dist/` (for JavaScript actions), force-pushes the moving major tag, and optionally rebuilds and pushes a Docker image.

```yaml
name: Release
on:
  release:
    types: [published, edited]

jobs:
  bundle-and-tag:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0          # needed to move tags
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run build        # bun build --target=node → dist/index.js
      - uses: JasonEtco/build-and-tag-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

`JasonEtco/build-and-tag-action` force-pushes the semver major, minor, and patch tags to the release commit after re-bundling. This is the idiomatic way to keep `dist/` and the moving `v1` tag in lockstep.

For a Docker-based action, the release workflow builds + pushes the image to GHCR instead:

```yaml
- uses: docker/build-push-action@v5
  with:
    context: .
    push: true
    tags: |
      ghcr.io/${{ github.repository }}:${{ github.event.release.tag_name }}
      ghcr.io/${{ github.repository }}:v1
```

Pair this with `image: 'docker://ghcr.io/org/action:v1'` in `action.yml` so consumers pull the prebuilt image.

## The `dist/` discipline (JavaScript actions)

**The problem:** a consumer pins `uses: org/action@v1` and the runner fetches whatever is at HEAD of `v1`. That includes your `dist/` bundle. If you push a code change without a matching `dist/` rebuild, consumers run stale code.

**Mitigations, pick one:**

1. **Release workflow rebuilds `dist/`.** Shown above with `JasonEtco/build-and-tag-action`. This is the most common approach. Drawback: the action's source commit ≠ the commit the tag points at, because the release workflow creates a new commit with the rebuilt bundle.
2. **CI checks `dist/` is up-to-date.** A CI job runs `bun run build` and fails if `git diff --exit-code dist/` is non-empty. Forces contributors to commit bundle updates themselves.
3. **Publish a prebuilt tarball as a release asset** and reference it from `action.yml`. Rare; works but adds complexity.

Pick one and document it in `CONTRIBUTING.md`. The worst outcome is having no strategy and silently shipping stale bundles.

## Branching strategy

GitHub Flow is the default:

- `main` is always releasable.
- Work happens on feature branches.
- PRs require green CI.
- Releases are cut from `main` via the GitHub UI (Draft → Publish Release), which the release workflow picks up.

For actions that need to support **multiple major versions simultaneously** (e.g. you still backport fixes to `v1` while `v2` is the new primary), maintain a long-lived `release/v1` branch. Cherry-pick fixes there; release from the branch instead of `main`.

## Communicating breaking changes

When cutting `v2`:

1. Write release notes that enumerate every breaking change.
2. Add a `MIGRATION.md` or a section in the README titled "Migrating from v1 to v2."
3. If possible, make `v1` emit a deprecation warning (`core.warning` in JS, `echo "::warning::..."` in Docker) so consumers notice in their logs.
4. Keep `v1` alive for bugfixes for a reasonable window (common: 6–12 months).

Never delete an old major tag. Deletion breaks any consumer that didn't migrate and cannot be rolled back.

## Security restrictions

`pull_request` workflows triggered from forks have a **restricted `GITHUB_TOKEN`** (read-only, no secret access). This is deliberate and cannot be loosened from the action side. If you're tempted to "just use `pull_request_target`" to get write access — that trigger runs with the **base repo's secrets** against **fork code**, which is a well-known RCE vector. Only use `pull_request_target` when you fully control which code paths execute (e.g. only running trusted steps, never checking out fork code).

## Community signals

These are not strictly required, but they dramatically increase trust for an action distributed externally:

- `README.md` with: what the action does, inputs/outputs table, usage examples, supported runners, version matrix.
- Workflow status badge in the README.
- `CHANGELOG.md` maintained per release.
- `LICENSE` (typically MIT for community actions, Apache-2.0 for corporate-owned actions — check with legal).
- `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md` (for reporting vulnerabilities out-of-band).
- An issue staleness action to close zombie issues after a reasonable window.

## Release checklist

Before hitting "Publish release":

- [ ] CI is green on the release commit.
- [ ] `dist/` (JS) or the published Docker image (Docker) is up-to-date and committed/pushed.
- [ ] `CHANGELOG.md` updated.
- [ ] Release notes written and migration docs added if breaking.
- [ ] Semver tag chosen correctly (major bump for breaking, minor for features, patch for fixes).
- [ ] You know whether this release should be marked **immutable** (see `immutable-releases.md`).
- [ ] Moving major tag will be updated by the release workflow — or you'll do it manually.

After publishing:

- [ ] Verify the moving major tag was updated (`git ls-remote --tags origin | grep refs/tags/v1`).
- [ ] Run a downstream smoke workflow that consumes `@v1` to confirm nothing regressed.
