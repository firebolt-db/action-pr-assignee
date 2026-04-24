# CLI Actions (`setup-$TOOL` pattern)

A very common action shape is "install a CLI tool on the runner so subsequent steps can call it." Examples in the wild: `actions/setup-node`, `ruby/setup-ruby`, `hashicorp/setup-terraform`, `google-github-actions/setup-gcloud`. This reference walks through building that pattern well.

## Goals

A good CLI setup action satisfies all of:

1. **Easy version selection.** Consumers pass `with: version: '1.2.3'` and get that version.
2. **Multi-OS support.** Works on Linux, macOS, and Windows runners (the common default).
3. **Fast.** Uses the runner's tool cache so repeated workflow runs don't re-download the same binary.
4. **Works on GitHub-hosted and self-hosted runners.** No assumptions about which dirs are writable, no reliance on pre-installed system packages.
5. **Composable.** Integrates with existing toolkit packages where possible instead of reinventing download/extract/verify logic.

These goals push you toward a **JavaScript action** using `@actions/core` + `@actions/tool-cache`. Docker is a poor fit (Linux only, slow cold start); composite is workable but reimplements what the toolkit gives you for free.

## Minimum working example

### `action.yml`

```yaml
name: 'Setup Foo'
description: 'Installs the foo CLI on the runner.'
inputs:
  version:
    description: 'The version of foo to install, e.g. 1.2.3.'
    required: true
  check-latest:
    description: 'If true, resolve `version` against the upstream release feed and install the latest matching version.'
    required: false
    default: 'false'
outputs:
  installed-version:
    description: 'The version that was actually installed.'
runs:
  using: 'node20'
  main: 'dist/index.js'
branding:
  icon: 'download'
  color: 'blue'
```

### `src/index.ts`

```typescript
import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import * as os from 'os';

async function run(): Promise<void> {
  try {
    const requestedVersion = core.getInput('version', { required: true });
    const version = await resolveVersion(requestedVersion);

    // 1. Check the runner's tool cache first.
    let installDir = tc.find('foo', version);

    // 2. On cache miss, download + extract + cache.
    if (!installDir) {
      const downloadUrl = getDownloadURL(version);
      core.info(`Downloading foo ${version} from ${downloadUrl}`);
      const tarball = await tc.downloadTool(downloadUrl);
      const extracted = await tc.extractTar(tarball);
      installDir = await tc.cacheDir(extracted, 'foo', version);
    } else {
      core.info(`Using cached foo ${version} from ${installDir}`);
    }

    // 3. Expose the binary on PATH.
    core.addPath(installDir);

    // 4. Advertise what was installed.
    core.setOutput('installed-version', version);
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

function getDownloadURL(version: string): string {
  const platform = os.platform();     // 'linux' | 'darwin' | 'win32'
  const arch = os.arch();             // 'x64' | 'arm64' | ...
  // TODO: map (platform, arch, version) to a real release URL.
  return `https://releases.example.com/foo/${version}/foo-${version}-${platform}-${arch}.tar.gz`;
}

async function resolveVersion(requested: string): Promise<string> {
  // If the consumer passed a concrete version, trust it.
  // Otherwise hit the upstream release feed (GitHub Releases API, etc.) and
  // resolve ranges like `^1.2` or `latest`.
  return requested;
}

run();
```

### `package.json`

```json
{
  "name": "setup-foo",
  "version": "1.0.0",
  "main": "dist/index.js",
  "scripts": {
    "build": "bun build --target=node --outfile=dist/index.js src/index.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@actions/core": "^1.10.1",
    "@actions/tool-cache": "^2.0.1"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "typescript": "^5.4.0"
  }
}
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
```

Bun is the bundler (`bun build --target=node`) — the runner still executes `dist/index.js` with Node, as declared by `runs.using: node20`. Bun handles TypeScript directly, so no separate `tsc` transpile step is needed for the bundle. `tsc --noEmit` remains useful as a typecheck gate in CI.

### `.gitignore`

**Do not** gitignore `dist/` — that's the file the runner actually loads when a consumer pins `@v1`. `node_modules/` should be ignored; `dist/` must be committed.

## Toolkit packages you should know

From `@actions/toolkit`:

| Package              | What it gives you |
|----------------------|-------------------|
| `@actions/core`      | Inputs, outputs, logging, `setFailed`, env/path manipulation, masking secrets. |
| `@actions/tool-cache`| Download, extract (tar/zip/7z/xar), cross-run caching (`find` / `cacheDir`). |
| `@actions/exec`      | Run child processes with streaming stdout/stderr, exit code capture. |
| `@actions/io`        | Cross-platform `mv`, `cp`, `rmRF`, `mkdirP`, `which`. |
| `@actions/github`    | Authenticated Octokit client honoring `GITHUB_API_URL` / `GITHUB_TOKEN`. |
| `@actions/glob`      | File globbing with `.gitignore` semantics. |

The `tool-cache` one is the whole ball game for setup actions. It handles:

- Downloading with resume + retries (`downloadTool`).
- Extracting (`extractTar`, `extractZip`, `extract7z`, `extractXar`).
- Cross-run caching (`cacheDir`, `cacheFile`, `find`, `findAllVersions`).

## Multi-OS considerations

```typescript
import * as os from 'os';

const platform = os.platform();

let extractFn: (file: string) => Promise<string>;
let url: string;
if (platform === 'win32') {
  url = `https://.../foo-${version}-windows-amd64.zip`;
  extractFn = tc.extractZip;
} else if (platform === 'darwin') {
  url = `https://.../foo-${version}-darwin-${os.arch()}.tar.gz`;
  extractFn = tc.extractTar;
} else {
  url = `https://.../foo-${version}-linux-${os.arch()}.tar.gz`;
  extractFn = tc.extractTar;
}
```

Common arches to handle: `x64`, `arm64`. Do not forget arm64 — both macOS (Apple Silicon self-hosted) and Linux (GitHub-hosted arm runners) are increasingly common.

## Checksum / signature verification

Production-quality setup actions verify what they downloaded. Pattern:

```typescript
import * as crypto from 'crypto';
import * as fs from 'fs';

async function verifySha256(filePath: string, expectedSha256: string): Promise<void> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  const actual = hash.digest('hex');
  if (actual !== expectedSha256) {
    throw new Error(`Checksum mismatch: expected ${expectedSha256}, got ${actual}`);
  }
}
```

Source of truth for the expected hash:

- A signed `SHA256SUMS` file published alongside the release.
- A per-release manifest file committed to the action repo.
- The upstream release API response.

Do not skip verification on the theory that TLS is sufficient. The attack surface is the upstream mirror, not the wire.

## Workflow usage

```yaml
jobs:
  build:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - uses: actions/checkout@v6
      - uses: org/setup-foo@v1
        with:
          version: '1.2.3'
        id: foo
      - run: foo --version
      - run: echo "Installed ${{ steps.foo.outputs.installed-version }}"
```

## Pre-existing real-world references

Look at these when in doubt — they all follow the pattern closely:

- [`actions/setup-node`](https://github.com/actions/setup-node)
- [`actions/setup-python`](https://github.com/actions/setup-python)
- [`actions/setup-go`](https://github.com/actions/setup-go)
- [`ruby/setup-ruby`](https://github.com/ruby/setup-ruby)
- [`hashicorp/setup-terraform`](https://github.com/hashicorp/setup-terraform)
- [`google-github-actions/setup-gcloud`](https://github.com/google-github-actions/setup-gcloud)

Copying their layout is encouraged — the pattern is well-established and consumers already know it.

## Failure modes

- **Forgetting `core.setFailed` in the `catch`.** An uncaught rejection prints a stack trace but the step still exits 0 on older Node versions. Always wrap `run()` in try/catch.
- **Not using `tc.cacheDir`.** Every workflow run re-downloads the tool. A 30MB binary × 100 runs/day = expensive noise.
- **Hardcoding an HTTPS URL that doesn't exist on arm64.** Test on at least `ubuntu-latest` + `macos-latest` before tagging `v1`.
- **Calling `core.addPath` with the wrong directory.** The directory passed to `addPath` must contain the binary itself (not the parent of a `bin/` subfolder). When in doubt, log the path and inspect with `core.info`.
