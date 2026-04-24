# Publishing to the GitHub Marketplace

The GitHub Marketplace is GitHub's directory of third-party actions. Listing there makes your action discoverable, puts it in the workflow editor's action picker, and enables the verified-creator badge. This reference covers the prerequisites, the publish flow, and the failure modes.

## Prerequisites

You can only publish if **all** of the following are true:

1. You've **accepted the GitHub Marketplace developer agreement** once per account/org.
2. The action lives in a **public** repository.
3. The repository has exactly **one** `action.yml` or `action.yaml` at the **repository root**. Metadata files in subdirectories won't be picked up by Marketplace auto-listing.
4. The repository contains **no workflow files** (`.github/workflows/*.yml`). This is the rule most people miss. Keep CI workflows for the action in a separate repo, or restructure so the action and its CI are decoupled.
5. The `action.yml` includes:
   - A `name:` that is **globally unique** across the Marketplace.
   - A `description:`.
   - A `branding:` block with `icon:` (from the allowed Feather icons list) and `color:` (one of the allowed values).
6. Two-factor authentication is **enabled on your GitHub account** — required to publish.

## Uniqueness rules for `name:`

Your action's `name:` cannot:

- Match the name of an already-published Marketplace action.
- Match a GitHub username or organization name (unless you are that user/org).
- Match a Marketplace category (e.g. don't name it `Deployment`).
- Use reserved GitHub feature names (`Codespaces`, `Pages`, `Actions`, etc.).
- Match a GitHub-operated product.

The publish UI will tell you if your name conflicts. Pick something distinctive and descriptive.

## Required `branding`

The `branding` block is optional in the schema but **required** for Marketplace listing — without it, the publish flow rejects the release.

```yaml
branding:
  icon: 'package'
  color: 'blue'
```

### Allowed colors

`white`, `yellow`, `blue`, `green`, `orange`, `red`, `purple`, `gray-dark`.

### Allowed icons

Any name from the [Feather Icons](https://feathericons.com/) set **except** the reserved list.

**Reserved (rejected) icons**: `coffee`, `columns`, `divide-circle`, `divide-square`, `divide`, `frown`, `hexagon`, `key`, `meh`, `mouse-pointer`, `smile`, `tool`, `x-octagon`, `x`.

Safe defaults: `package`, `box`, `zap`, `activity`, `upload`, `download`, `shield`, `terminal`, `check-circle`.

## Publish flow

1. Commit and push the action metadata, code, and bundled artifacts to a public repo.
2. On GitHub, navigate to the repo's main page.
3. Click **Draft a release**. GitHub detects `action.yml` and surfaces a Marketplace publishing banner.
4. Check the box **Publish this Action to the GitHub Marketplace**.
5. Accept the Marketplace terms of service (if this is the first time).
6. GitHub validates the metadata. You want to see **Everything looks good!** If not, fix the issues it lists (usually missing `branding` fields, name collisions, or workflow files in the repo).
7. Choose a **primary category** and optionally a **secondary category** (see list below).
8. Enter a **tag** (e.g. `v1.0.0`) and **release title**.
9. Write release notes (the Marketplace displays these).
10. Click **Publish release**. GitHub will require 2FA reauthentication.

The action appears in the Marketplace directory within a few minutes.

## Categories

Primary categories include (non-exhaustive — GitHub's list evolves):

- API management
- Chat
- Code quality
- Code review
- Continuous integration
- Container CI
- Dependency management
- Deployment
- Learning
- Localization
- Mobile CI
- Monitoring
- Project management
- Publishing
- Security
- Support
- Testing
- Utilities

Pick the category that most closely matches what consumers would search for. The secondary category is optional but surfaces your action to a second audience.

## Subsequent releases

Every subsequent release is published the same way: Draft a release, tag with a new semver, optionally republish to Marketplace. If the box is already checked from the previous release, it stays checked — confirm before clicking Publish.

Marketplace displays only the **latest** release on the action's listing page. Older versions are still installable (consumers can pin to any tag) but aren't prominent.

## Removing from the Marketplace

1. Navigate to the repository's **Releases**.
2. For each released version, click **Edit**.
3. **Uncheck** "Publish this action to the GitHub Marketplace."
4. Click **Update release**.
5. Repeat for every published version — unchecking one doesn't affect the others.

The action is immediately delisted from the Marketplace, but consumers who already reference it by `uses:` continue to resolve it from the repo as normal. To fully break consumers, you'd also have to delete the tags / archive the repo — which is destructive and should be avoided unless the action is being retired for a security reason.

## Verified Creator badge

Actions from verified publishers get a badge on their Marketplace card. Verification is manual and typically granted to:

- GitHub partners (organizations with an existing partnership).
- Organizations that reach out to `partnerships@github.com` with evidence of legitimacy.

The badge is per-organization, not per-action — once granted, all actions published by that org show the badge.

## Rejection reasons (and their fixes)

If the **Everything looks good!** banner doesn't appear, you hit one of:

| Error                                                      | Fix                                                                |
|------------------------------------------------------------|--------------------------------------------------------------------|
| "Name already in use"                                       | Rename the action. `name:` must be Marketplace-unique.             |
| "Name conflicts with a GitHub user/org/product/category"    | Rename.                                                            |
| "Missing branding"                                          | Add `branding.icon` and `branding.color` to `action.yml`.          |
| "Invalid icon" or "Icon is reserved"                        | Pick a non-reserved icon from the Feather set.                     |
| "Invalid color"                                             | Pick one of the 8 allowed colors.                                  |
| "Multiple action metadata files found"                      | Ensure exactly one `action.yml`/`action.yaml` at repo root.        |
| "Workflow files found in repository"                        | Move workflow files out (separate repo), or delete them.           |
| "`action.yml` not at repo root"                             | Move it to the root.                                               |
| "Description missing"                                       | Add `description:` to `action.yml`.                                |
| "Input missing description"                                 | Every `inputs.<name>` needs a `description`.                       |

## Checklist before publishing

- [ ] Repo is public.
- [ ] Single `action.yml` at repo root.
- [ ] No workflow files in the repo.
- [ ] `name:` is unique on the Marketplace.
- [ ] `description:` present.
- [ ] Every input and output has a `description`.
- [ ] `branding.icon` + `branding.color` present, icon not in reserved list.
- [ ] README has usage examples, inputs/outputs tables, and a supported-runners statement.
- [ ] A real release has been cut with a semver tag (`v1.0.0`).
- [ ] 2FA is enabled on your account.
- [ ] (If immutable releases are enabled) you've decided whether this release should be immutable.

## What Marketplace doesn't give you

Listing on the Marketplace does **not**:

- Guarantee quality — there is no review process for content.
- Make the action safer — consumers must still audit and pin.
- Automatically update consumers — they control their own pinning.
- Prevent name squatting after delisting — reserved names may remain held by GitHub.

Treat Marketplace listing as a discoverability feature, not an endorsement.
