# Action Types

GitHub Actions supports exactly three action types. Pick once, deliberately — the type drives the repo layout, the runtime contract, and the list of platforms the action can run on.

## Summary

| Dimension                  | Docker container             | JavaScript                        | Composite                        |
|----------------------------|------------------------------|-----------------------------------|----------------------------------|
| Runs on Linux              | yes                          | yes                               | yes                              |
| Runs on macOS / Windows    | **no**                       | yes                               | yes                              |
| Cold-start cost            | high (image build or pull)   | low (node starts fast)            | low (just shell)                 |
| Can call existing actions  | no (self-contained)          | no                                | **yes** (`uses:` inside `steps:`)|
| Language/runtime flexibility | any (you control the image) | Node.js only                      | shell / any tool via `run:`      |
| Requires a build step      | Dockerfile build             | typically yes (bundle to `dist/`) | no                               |
| Good fit for               | CLI wrappers with system deps, non-Node runtimes, isolation | Cross-OS setup tools, GitHub API clients | Glueing existing actions + shell steps |

## Docker container actions

The action packages your code into a Docker image. The runner runs the image and passes inputs via env vars (`INPUT_<NAME>`) and/or process args.

**Use Docker when:**

- You need a specific system-level dependency (an apt package, a compiled binary, a specific Linux distro).
- You need a non-Node runtime (Python, Ruby, Go) and you don't want to use a `setup-*` action.
- You need isolation between the action and the runner environment.

**Don't use Docker when:**

- The user runs GitHub Actions on macOS or Windows runners — Docker container actions only run on Linux runners.
- Startup latency matters. The runner has to pull or build the image before your code executes; this can add 30–90 seconds on every workflow run.

### Minimum repo layout

```
my-action/
├── action.yml
├── Dockerfile
├── entrypoint.sh
└── README.md
```

`runs:` block:

```yaml
runs:
  using: 'docker'
  image: 'Dockerfile'          # or 'docker://ghcr.io/org/image:tag' for a prebuilt image
  entrypoint: 'entrypoint.sh'  # optional; Dockerfile CMD/ENTRYPOINT also works
  args:
    - ${{ inputs.greeting }}
```

Referencing a **prebuilt image** from a registry (e.g. `docker://ghcr.io/org/image:v1`) skips the per-run build and is the usual production choice — build once in a release workflow, publish to GHCR, and pin the image by SHA.

## JavaScript actions

The action is Node.js code executed directly on the runner, with access to `@actions/core`, `@actions/github`, `@actions/tool-cache`, `@actions/exec`, and the rest of the GitHub Actions toolkit.

**Use JavaScript when:**

- You need to run on Linux, macOS, **and** Windows.
- You're wrapping a CLI (`setup-$TOOL` pattern) — `@actions/tool-cache` gives you download, extract, and runner-level caching for free.
- You're calling the GitHub API — `@actions/github` wires up the authenticated Octokit client and respects `GITHUB_API_URL`.

### Minimum repo layout

```
my-action/
├── action.yml
├── package.json
├── tsconfig.json
├── bun.lockb               # committed lockfile (all-Bun workflow)
├── src/
│   └── index.ts            # TypeScript source
└── dist/
    └── index.js            # bundled output (bun build --target=node) — committed, pinned by semver tag
```

`runs:` block:

```yaml
runs:
  using: 'node20'
  main: 'dist/index.js'
  # Optional hooks:
  pre: 'dist/setup.js'       # runs before `main` on the same step
  pre-if: "runner.os == 'linux'"
  post: 'dist/cleanup.js'    # runs after the job, even on failure
  post-if: "success()"
```

### The `dist/` gotcha

Consumers pin to `uses: org/action@v1`. When they resolve that tag, they get **whatever is committed at that tag**, including `dist/index.js`. So if you edit `src/index.ts` but forget to rebuild and commit `dist/`, your users run stale code. Two options:

1. **Commit `dist/`** (the common pattern). Keep a release workflow that rebuilds and pushes `dist/` when you cut a release — e.g. `JasonEtco/build-and-tag-action`. Enforce "no code changes without a matching `dist/` rebuild" in CI.
2. **Publish to a registry instead** and reference the bundled artifact — less common, more operational overhead.

The standard toolchain for this skill: write source in TypeScript, bundle with `bun build --target=node --outfile=dist/index.js src/index.ts`. Bun runs at *build time only* — the committed `dist/index.js` is executed by Node on the runner (`runs.using: node20`).

### Node version

- Always declare `runs.using:` as the newest supported Node (currently `node20`, moving to `node24`).
- Do **not** use `node16` or earlier; they are deprecated and the runner will emit a deprecation warning now and break later.

## Composite actions

The action is a list of steps in YAML — shell `run:` steps and/or `uses:` references to other actions. No separate language, no build step.

**Use composite when:**

- The logic is "call these three existing actions, then run these shell commands." You're mostly orchestrating.
- You want to expose a clean interface over a sequence that currently gets copy-pasted across repos.
- You don't need access to the GitHub API beyond what `gh` CLI or a referenced action already provides.

### Minimum repo layout

```
my-action/
├── action.yml
└── README.md
```

`runs:` block:

```yaml
runs:
  using: 'composite'
  steps:
    - name: Install foo
      run: |
        curl -L "https://example.com/foo-${{ inputs.version }}.tar.gz" | tar xz
      shell: bash
    - name: Call another action
      uses: actions/setup-node@v4
      with:
        node-version: ${{ inputs.node-version }}
    - name: Export something
      id: export
      run: echo "foo=bar" >> "$GITHUB_OUTPUT"
      shell: bash
```

### Composite-specific rules

- **Every `run:` step must declare `shell:`.** There is no default shell for composite actions — omitting `shell:` is a validation error. Common values: `bash`, `pwsh`, `sh`, `python`, `cmd`.
- **Outputs need `value:` in the metadata.** Unlike Docker/JS, composite outputs are declared with an explicit value reference:
  ```yaml
  outputs:
    result:
      description: 'The computed result'
      value: ${{ steps.export.outputs.foo }}
  ```
- **`continue-on-error` works per step.** If you want a step that may fail without failing the whole action, set `continue-on-error: true` on that step.
- **Environment variables set in one step persist** (via `$GITHUB_ENV`) for subsequent steps in the same composite, just like in workflows.

## Decision cheatsheet

Ask these in order:

1. Is the primary purpose "install a CLI tool on the runner"? → **JavaScript** (`setup-$TOOL` pattern).
2. Does it need to run on macOS or Windows? → **JavaScript** or **composite** (never Docker).
3. Is the logic "run a few shell commands, maybe call an existing action"? → **composite**.
4. Does it need a system package, a non-Node runtime, or strict isolation? → **Docker**.
5. None of the above but you're writing real code with logic? → **JavaScript**.

If the user is unsure between JavaScript and composite, lean composite unless they need programmatic GitHub API access or complex control flow.
