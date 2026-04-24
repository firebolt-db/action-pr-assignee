# `action.yml` / `action.yaml` — Full Metadata Schema

The metadata file is the sole contract between your action and every workflow that uses it. A single typo here (missing `description:`, wrong `using:`, broken `value:` expression in a composite output) is the #1 cause of "my action won't load." This reference documents every field and every type-specific variant.

The file must be named `action.yml` or `action.yaml`. Pick one per repo and stick with it. For a public/shared action it **must** be at the repo root.

## Top-level skeleton

```yaml
name: 'My Action'                 # required
author: 'Firebolt'                # optional
description: 'What this does.'    # required
inputs:                           # optional map
  ...
outputs:                          # optional map
  ...
runs:                             # required; shape depends on type
  ...
branding:                         # required for Marketplace publishing, optional otherwise
  icon: 'activity'
  color: 'blue'
```

## `name` (required)

A human-readable name displayed in the Marketplace and in logs. If you publish to the Marketplace, it **must be globally unique** and cannot collide with existing published actions, GitHub feature names, usernames, organization names, or Marketplace categories. Keep it short; full sentences belong in `description`.

## `author` (optional)

Displayed on the Marketplace card. Typically the org or individual publishing the action.

## `description` (required)

One-line summary. Shown in the Marketplace, in GitHub's action picker, and in workflow visualization.

## `inputs` — full schema

A map from input name to input definition. Input names are **kebab-case** by convention and are **case-insensitive** when resolved by the runner.

```yaml
inputs:
  greeting:
    description: 'The greeting to print.'   # required
    required: true                          # optional; default false
    default: 'Hello'                        # optional
    deprecationMessage: 'Use `message` instead.'  # optional; logged as a warning when the input is supplied
```

**How inputs reach your code, by type:**

| Action type   | Access pattern                                                    |
|---------------|-------------------------------------------------------------------|
| JavaScript    | `core.getInput('greeting')` from `@actions/core`                  |
| Docker        | Env var `INPUT_GREETING` (uppercased, hyphens → underscores)       |
| Composite     | `${{ inputs.greeting }}` inside `run:` or `with:` blocks           |

Notes:

- `required: true` does not enforce non-empty — a consumer can pass `greeting: ''`. Validate inside your handler.
- `default:` values are substituted by the runner before the action runs.
- `deprecationMessage:` surfaces a warning in the workflow log when the input is actually used.

## `outputs` — full schema

Outputs let downstream steps read results via `${{ steps.<id>.outputs.<name> }}`.

### Docker / JavaScript outputs

```yaml
outputs:
  result:
    description: 'The computed result.'
```

The handler sets the value at runtime:

- **JavaScript**: `core.setOutput('result', computedValue)`
- **Docker**: write to `$GITHUB_OUTPUT`:
  ```bash
  echo "result=$VALUE" >> "$GITHUB_OUTPUT"
  ```

### Composite outputs

Composite outputs **must** include `value:` in the metadata (this is the key asymmetry with Docker/JS outputs):

```yaml
outputs:
  result:
    description: 'The computed result.'
    value: ${{ steps.calculate.outputs.number }}

runs:
  using: 'composite'
  steps:
    - id: calculate
      run: echo "number=42" >> "$GITHUB_OUTPUT"
      shell: bash
```

Forgetting `value:` on a composite output is a silent bug: the output is declared, but consumers read an empty string.

## `runs` — by action type

This is the only top-level field whose shape depends on the action type.

### Docker container

```yaml
runs:
  using: 'docker'
  image: 'Dockerfile'            # or 'docker://ghcr.io/org/img:tag'
  pre-entrypoint: 'setup.sh'     # optional; runs before `entrypoint`
  entrypoint: 'entrypoint.sh'    # optional; overrides Dockerfile ENTRYPOINT
  post-entrypoint: 'cleanup.sh'  # optional; runs after the job, even on failure
  args:                          # optional; passed as CMD to the container
    - ${{ inputs.greeting }}
  env:                           # optional; extra env vars
    EXTRA_VAR: 'some-value'
```

- `image: 'Dockerfile'` means "build from the `Dockerfile` in the action repo on every run" — slow; use a prebuilt image in production.
- `image: 'docker://<registry>/<image>:<tag>'` pulls a prebuilt image. Pin by SHA (`@sha256:...`) for supply-chain safety.
- `pre-entrypoint` and `post-entrypoint` run in **fresh containers** — they do not share filesystem state with `entrypoint` beyond what's written to the runner's workspace.
- `args:` becomes the container `CMD`. Inputs passed this way are also still available as `INPUT_*` env vars — prefer env vars for structured inputs, args for positional ones.

### JavaScript

```yaml
runs:
  using: 'node20'                # or 'node24'; do NOT use node16 or older
  main: 'dist/index.js'          # required
  pre: 'dist/setup.js'           # optional
  pre-if: "runner.os == 'linux'" # optional expression gating `pre`
  post: 'dist/cleanup.js'        # optional; runs after the job
  post-if: "success()"           # optional; default is "always()"
```

- `main` is the script the runner executes for the step.
- `pre` runs **before** `main` on the same step. Useful for setup that must happen before user-visible work.
- `post` runs **after the job finishes**, regardless of whether the job succeeded or failed. Useful for cleanup, cache saves, and teardown.
- `pre-if` / `post-if` use GitHub's expression syntax. Common values: `success()`, `failure()`, `always()`, `cancelled()`, or any boolean expression referencing `runner.*`, `env.*`, etc.

### Composite

```yaml
runs:
  using: 'composite'
  steps:
    - name: Install
      run: ./install.sh
      shell: bash
      working-directory: ./src
      env:
        TOKEN: ${{ inputs.token }}
    - name: Call another action
      uses: actions/setup-node@v4
      with:
        node-version: ${{ inputs.node-version }}
    - name: Conditional step
      if: runner.os == 'Linux'
      run: echo linux
      shell: bash
      continue-on-error: true
```

Composite step fields:

| Field              | Required?                            | Notes |
|--------------------|--------------------------------------|-------|
| `name`             | optional                             | Display name in logs |
| `id`               | optional                             | Needed if outputs reference this step |
| `run`              | required if the step isn't `uses:`   | Shell command(s) |
| `shell`            | **required on every `run:` step**    | `bash`, `pwsh`, `sh`, `cmd`, `python`, ... |
| `uses`             | required if the step isn't `run:`    | Reference to another action |
| `with`             | optional (for `uses:` steps)         | Inputs map |
| `env`              | optional                             | Step-scoped env vars |
| `if`               | optional                             | Conditional expression |
| `working-directory`| optional                             | Changes cwd for the step |
| `continue-on-error`| optional                             | `true` means this step's failure does not fail the action |

## `branding`

Required for **Marketplace publishing**; optional otherwise. Drives the Marketplace card icon and color.

```yaml
branding:
  icon: 'activity'
  color: 'blue'
```

### `branding.color` — allowed values

One of: `white`, `yellow`, `blue`, `green`, `orange`, `red`, `purple`, `gray-dark`.

### `branding.icon` — allowed values

A name from the [Feather Icons](https://feathericons.com/) set, e.g. `activity`, `airplay`, `anchor`, `archive`, `award`, `bell`, `box`, `camera`, `check-circle`, `clipboard`, `cloud`, `code`, `database`, `download`, `edit`, `file`, `filter`, `flag`, `folder`, `gift`, `globe`, `hard-drive`, `heart`, `home`, `image`, `info`, `layers`, `link`, `lock`, `mail`, `map`, `moon`, `package`, `paperclip`, `play`, `power`, `printer`, `refresh-cw`, `rocket`, `search`, `server`, `settings`, `shield`, `shuffle`, `sliders`, `star`, `sun`, `tag`, `target`, `terminal`, `thumbs-up`, `trash`, `truck`, `umbrella`, `upload`, `user`, `users`, `video`, `watch`, `wifi`, `zap`, `zoom-in`.

**Reserved / rejected icons** (submitting these blocks Marketplace listing): `coffee`, `columns`, `divide-circle`, `divide-square`, `divide`, `frown`, `hexagon`, `key`, `meh`, `mouse-pointer`, `smile`, `tool`, `x-octagon`, `x`.

If in doubt, pick `activity`, `zap`, `package`, or `box` — all are allowed and visually neutral.

## Referencing the action from a workflow

```yaml
jobs:
  greet:
    runs-on: ubuntu-latest
    steps:
      # Pin to a major tag (moves with releases):
      - uses: org/my-action@v1

      # Pin to a full semver tag (immutable, recommended for production):
      - uses: org/my-action@v1.2.3

      # Pin to a full commit SHA (maximum supply-chain safety; Firebolt default):
      - uses: org/my-action@a1b2c3d4e5f6...

      # Reference by branch (dev/test only — never production):
      - uses: org/my-action@main

      # Private internal action living in the same repo:
      - uses: ./.github/actions/my-action

        with:
          greeting: 'Hello'
        id: step1

      - run: echo "Got ${{ steps.step1.outputs.result }}"
```

## Validation checklist

Before you commit `action.yml`, confirm:

- [ ] `name`, `description`, and `runs` are present.
- [ ] Every `inputs.<name>` has a `description`.
- [ ] Every `outputs.<name>` has a `description`.
- [ ] For composite: every `outputs.<name>` has `value:`.
- [ ] For composite: every `run:` step declares `shell:`.
- [ ] `runs.using` is one of `docker`, `node20`/`node24`, or `composite` (not `node12`/`node16`).
- [ ] If Marketplace: `branding.icon` and `branding.color` are present and not in the reserved list.
- [ ] If Marketplace: the file is at the **repo root**, not in a subdirectory.

Testing locally: run a real workflow against a PR in the same repo using `uses: ./` (self-reference) — this is the fastest feedback loop. For a standalone action repo, push a branch and reference it as `uses: org/action@branch-name` from a test workflow in another repo.
