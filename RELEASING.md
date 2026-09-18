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

`PhoenixChannel` is still slated for removal — the `0.2.0` changelog says so — and that
removal is a breaking change, so it takes a minor of its own when it lands.

## What the workflow does

`.github/workflows/release.yml` runs five jobs:

| Job | What it does |
| --- | --- |
| `resolve` | Works out the version from the tag (or the manual input) |
| `test` | Lint, build, unit tests on Node 20 |
| `compat-test` | Compatibility suite |
| `publish-npm` | Publishes `@layr8/sdk` to npm, unless the registry says it is already there |
| `publish-compat-image` | Waits for npm to serve the new version, builds and pushes the compat image, then triggers the compat gate |

The wait is not decoration. The npm registry is not read-your-writes: v0.4.9
published, `publish-compat-image` started, and the Dockerfile's
`npm install @layr8/sdk@0.4.9` failed with `notarget`. Re-running the same job
minutes later passed with no other change. `scripts/wait-for-npm-version.sh`
polls `npm view` for up to five minutes and fails with a message naming the version
and the time it actually waited, so a release that genuinely did not publish still
goes red.

The wait shrinks that window; it does not close it. `npm view` revalidates with the
registry on every call, so the wait cannot pass on a cached answer — but the `npm
install` inside the docker build is a different client on a different network path
with an empty cache, and may reach an edge this runner did not.

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

Every publishing step is idempotent, and re-running is safe. To re-drive a release,
use the manual trigger:

```bash
gh workflow run release.yml -f version=0.2.1
```

This checks out the `v0.2.1` tag, skips whatever already published, and completes the
rest.

**What "idempotent" rests on, and what it does not.** Each step checks whether the
artifact already exists — `npm view` for the package, `docker manifest inspect` for
the image — and skips if so. For the image that check is conclusive. For npm it is
not: the registry is not read-your-writes, so a re-drive inside that window can read
"not published", publish, and be refused with `EPUBLISHCONFLICT`. A read cannot close
that window, because whether something is published is decided by whoever accepts the
publish. So `scripts/publish-if-absent.sh` keeps the read as the cheap path and treats
the registry's duplicate refusal as success: the version is on npm, which is what the
release needed. Any other publish failure is still a failure and still goes red.

The same window is why `publish-compat-image` waits (above) rather than assuming the
version it just published can be installed.

## Checking a release landed

```bash
npm view @layr8/sdk version
gh api /orgs/layr8/packages/container/node-sdk%2Fcompat/versions \
  --jq '.[].metadata.container.tags'
```

Both should show the new version. If npm has it but the container registry does not, the
chain broke midway — re-drive it with the manual trigger above.
