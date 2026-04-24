# Immutable Releases and Tags

GitHub supports marking releases as **immutable**: once published, their tag cannot be retargeted to a different commit, and the release artifacts cannot be modified. This is a supply-chain feature — it gives consumers a way to pin to a tag with the same safety they'd get from pinning to a commit SHA, without the readability cost.

Immutable releases and the moving-major-tag convention (`v1`, `v2`) look contradictory at first glance. They aren't. This reference explains how the two coexist.

## What "immutable" means here

A GitHub Release associates a **tag** (e.g. `v1.2.3`) with a **commit** and a set of **release assets**. Normally:

- The tag can be force-pushed to a different commit (with write access).
- Release assets can be re-uploaded.
- The release notes can be edited.

When a release is marked immutable:

- The **tag is locked** to its current commit. Force-pushing is rejected by GitHub.
- The **release assets are locked** — once uploaded, they cannot be replaced.
- Release notes can typically still be edited (this is metadata, not a supply-chain concern).

An immutable release is effectively equivalent, from a consumer's trust perspective, to pinning by commit SHA — but preserves the readability of a semver tag.

## Why you'd enable it

- **Supply-chain attestation.** Consumers can audit "this version is immutable" as a property of the release, not a property of their pinning discipline.
- **Meeting downstream security policy.** Some orgs require dependencies to be pinned to immutable refs; marking your releases immutable makes your action eligible without forcing every consumer to SHA-pin.
- **Signaling stability.** An immutable release is a clear statement: "this is done; no silent updates."

## The interaction with moving major tags

This is the piece people get confused about.

**The rule:** immutable releases apply to the **full-version tag** (e.g. `v1.2.3`), not to your moving major tag (`v1`).

- Create a GitHub **Release** at `v1.2.3` and mark it immutable. The `v1.2.3` tag is now locked to that commit forever.
- Separately, the Git tag `v1` is **not a GitHub Release** — it's a plain moving tag you force-push with each new release. Immutability doesn't apply to it.

So the setup is:

```
v1.0.0    GitHub Release (immutable) → commit A
v1.0.1    GitHub Release (immutable) → commit B
v1.1.0    GitHub Release (immutable) → commit C
v1        Plain Git tag (movable)    → currently commit C
```

Consumers have three pinning options, trading safety for convenience:

| Pin                 | Stability            | Auto-updates           | Notes                            |
|---------------------|----------------------|------------------------|----------------------------------|
| `@v1.1.0`           | Strongest            | Never                  | Immutable release                |
| `@v1`               | Moderate             | Non-breaking updates   | Moving tag; you force-push it    |
| `@<commit-sha>`     | Strongest            | Never                  | Same safety as immutable release |

## How to enable immutable releases

On the repo: **Settings → General → Releases → Immutable releases**.

Once enabled, every release created after that point is immutable by default. Existing (pre-enablement) releases remain mutable unless explicitly converted.

Alternatively, some actions (e.g. a release workflow) support immutability as a release flag — check the GitHub REST API for `immutable: true` on the release creation endpoint.

## Moving the major tag with immutability on

Your release workflow still force-pushes `v1` to the latest release commit. This works because `v1` is **just a Git tag**, not a GitHub Release. Only the GitHub Release created at `v1.2.3` is immutable.

```bash
git tag v1.2.3
git push origin v1.2.3

# Then — separately — move the major:
git tag -f v1 v1.2.3
git push -f origin v1
```

If you **do** accidentally create a GitHub Release at the `v1` tag (not just `v1.2.3`), and then mark it immutable, you've trapped yourself: you can no longer move `v1`. Don't create Releases at the moving-major tag. Create them only at full semver tags.

## Choosing: release-per-tag vs. tag-only

When you publish a version, decide per-version:

- **GitHub Release (optionally immutable)** for versions you want consumers to pin to permanently. This is your public API — every `v1.x.y` should be a Release.
- **Git-tag-only** for versions you want to move later. This is rare in practice — once you cut a semver version, don't un-cut it. The tag-only option is mostly relevant for the moving major/minor tags.

## Migrating an existing action to immutable releases

1. Turn on immutable releases at the repo level.
2. New releases are immutable going forward. Old releases remain mutable.
3. Don't retroactively make old releases immutable unless you're certain they are exactly what you want them to be forever. Once immutable, you can't fix a tag that points at the wrong commit.
4. Keep moving `v1` / `v2` as before — immutability doesn't apply to plain Git tags.
5. Update your README to recommend the right pin per use case (see table above).

## Pitfalls

- **Marking `v1` (the moving tag) as an immutable Release.** Traps the tag. Don't do it.
- **Assuming immutability means "consumers are safe."** Consumers still have to pin to the immutable tag — if they pin `@v1`, they're still subject to moving-tag risk. The feature is opt-in from both sides.
- **Editing a release's assets expecting them to update for consumers.** If the release is immutable, asset re-upload is blocked. Cut a new version instead.
- **Expecting immutability to apply retroactively.** Pre-enablement releases aren't automatically immutable.

## When to turn it on

Default recommendation for Firebolt-owned actions: **enable immutable releases**. The cost is low (you lose the ability to silently fix a broken release — which you shouldn't be doing anyway; cut a new patch instead) and the supply-chain benefit is real.

Don't enable it if you're actively iterating on pre-1.0 releases that you expect to retag frequently. For prerelease/beta work, use a branch or a `v0.x-beta` tag and wait to flip on immutability until you're ready to commit to a stable API.
