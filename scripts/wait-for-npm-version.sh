#!/usr/bin/env bash
#
# Waits until a version of @layr8/sdk is resolvable on the npm registry.
#
# This exists because the release chain raced itself. `publish-npm` published
# v0.4.9 and `publish-compat-image` started immediately; the Dockerfile's
# `npm install @layr8/sdk@${SDK_VERSION}` got
#
#   npm error code ETARGET
#   npm error notarget No matching version found for @layr8/sdk@0.4.9
#
# and the release stopped halfway. Re-running the same job minutes later
# passed with no other change — the publish had landed, the registry had just
# not made it resolvable yet. The registry is not read-your-writes, so a
# consumer of a just-published version has to wait for it rather than assume
# it.
#
# The wait cannot pass on a stale cached answer: `npm view` revalidates with
# the registry on every call (measured — never a plain cache hit). What it
# CANNOT do is speak for the next hop: the `npm install` inside the docker
# build runs on a different network path with an empty cache, and may reach a
# registry edge that this runner did not. So this shrinks the window; it does
# not close it. If the install ever fails with `notarget` again despite a
# successful wait, that is the reason, and the answer is a longer wait or a
# retry around the build — not a shorter one here.
#
# Usage:
#   scripts/wait-for-npm-version.sh <version>
#
# Environment (defaults chosen for CI; the tests set them low):
#   NPM_WAIT_ATTEMPTS   how many times to look          (default 30)
#   NPM_WAIT_DELAY      seconds between looks           (default 10)
#   NPM_WAIT_PACKAGE    package name                    (default @layr8/sdk)
#
# Exits 0 as soon as the version resolves. Exits 1 with a message naming the
# version and the total time waited when it never does — a release that is
# genuinely broken must fail loudly, not be papered over by an unbounded wait.

set -uo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: $0 <version>" >&2
  exit 2
fi

PACKAGE="${NPM_WAIT_PACKAGE:-@layr8/sdk}"
ATTEMPTS="${NPM_WAIT_ATTEMPTS:-30}"
DELAY="${NPM_WAIT_DELAY:-10}"

# SECONDS is bash's own counter, reset here so the failure below reports time
# that was MEASURED. `ATTEMPTS * DELAY` would understate it: the loop also
# sleeps after the last look, and 30 registry round-trips are not free — the
# arithmetic said 300s where the real elapsed is ~305-330s.
SECONDS=0

for attempt in $(seq 1 "$ATTEMPTS"); do
  if npm view "$PACKAGE@$VERSION" version >/dev/null 2>&1; then
    echo "$PACKAGE@$VERSION is resolvable on the registry (attempt $attempt)."
    exit 0
  fi
  echo "$PACKAGE@$VERSION not resolvable yet (attempt $attempt/$ATTEMPTS); waiting ${DELAY}s."
  sleep "$DELAY"
done

echo "::error::$PACKAGE@$VERSION was still not resolvable on the npm registry after ${SECONDS}s ($ATTEMPTS attempts). The publish job reported success, so either the publish did not land or the registry is far slower than usual. Check 'npm view $PACKAGE versions', then re-drive the release with: gh workflow run release.yml -f version=$VERSION" >&2
exit 1
