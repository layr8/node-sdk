# Releasing

## TL;DR

Pushing a git tag does **not** publish anything. The release workflow triggers on
`release: published`, so you must create a GitHub Release.

```bash
# 0. start from an up-to-date main
git checkout main && git pull

# 1. bump the version and close out the changelog
npm version 0.2.2 --no-git-tag-version
$EDITOR CHANGELOG.md   # [Unreleased] -> [0.2.2] - <date>, add the link at the bottom

# 2. open a PR — release prep goes through review like anything else
git checkout -b release/0.2.2
git commit -am "Bump version to 0.2.2"
gh pr create --base main --title "Bump version to 0.2.2"
# wait for CI, then merge

# 3. cut the release (this creates the tag and triggers publishing)
gh release create v0.2.2 --title "v0.2.2 — <short summary>" --notes "<release notes>"
```

Step 3 is the one that publishes. `gh release create` creates the tag for you, so
there is no separate tagging step.

The tag must be `v` + the exact `version` in `package.json`. The workflow hard-fails
if they disagree.

## Choosing the version

| Change | Bump |
| --- | --- |
| New API, bug fix — anything additive | patch (`0.2.1` → `0.2.2`) |
| Breaking change to an existing API | minor (`0.2.x` → `0.3.0`) |

Minor is reserved for breaking changes here, which is narrower than SemVer requires for
`0.x`. Two reasons to keep it that way:

- It matches what the history already says. `0.1.6`–`0.1.12` were fixes; the one minor
  bump, `0.2.0`, split `PhoenixChannel` into `Connection` + `Channel`.
- npm reads `^0.2.0` as `>=0.2.0 <0.3.0`, so shipping an additive change as a patch
  reaches consumers without each of them editing its range. Shipping it as a minor
  strands them.

`0.3.0` is already spoken for: the `0.2.0` changelog slates `PhoenixChannel` for removal,
and that removal is the next real breaking change.

## What the workflow does

`.github/workflows/release.yml` runs five jobs:

| Job | What it does |
| --- | --- |
| `resolve` | Works out the version from the tag (or the manual input) |
| `test` | Lint, build, unit tests on Node 20 |
| `compat-test` | Compatibility suite |
| `publish-npm` | Publishes `@layr8/sdk` to npm |
| `publish-compat-image` | Builds and pushes the compat image, then triggers the compat gate |

`test` and `compat-test` duplicate what CI already ran on `main`. That is deliberate —
a release can be cut from any commit, so the release chain re-verifies the exact tag it
is about to publish.

## Credentials

npm publishing uses [trusted publishing](https://docs.npmjs.com/trusted-publishers)
over OIDC. The workflow mints a short-lived credential via `id-token: write` and
exchanges it with the registry.

**There is no npm token.** Nothing to expire, rotate, or leak. If you are editing the
publish job, do not add `NODE_AUTH_TOKEN` — setting it makes npm prefer the token and
silently bypass OIDC.

Two constraints follow from this and must not be lowered:

- The publish job runs Node 24. Trusted publishing needs Node >= 22.14 and npm >= 11.5.1.
- `--provenance` is not passed. Trusted publishing generates provenance automatically.

The compat gate still uses a PAT (`COMPAT_GATE_PAT`), because it dispatches to a
different repository.

## When a release partially fails

Every publishing step is idempotent — it checks whether the artifact already exists and
skips if so. To re-drive a release, use the manual trigger:

```bash
gh workflow run release.yml -f version=0.2.1
```

This checks out the `v0.2.1` tag, skips whatever already published, and completes the
rest. It is always safe to re-run.

## Checking a release landed

```bash
npm view @layr8/sdk version
gh api /orgs/layr8/packages/container/node-sdk%2Fcompat/versions \
  --jq '.[].metadata.container.tags'
```

Both should show the new version. If npm has it but the container registry does not, the
chain broke midway — re-drive it with the manual trigger above.
