#!/usr/bin/env bash
#
# Publishes @layr8/sdk unless that version is already on the registry, and
# treats the registry's own "already published" answer as success.
#
# WHY THE SECOND HALF EXISTS. The workflow's header says every publishing step
# is idempotent and a re-drive is always safe. The skip that made that true
# was `npm view <pkg>@<version>` — a read — and the npm registry is not
# read-your-writes. In the same window that broke the compat image (see
# scripts/wait-for-npm-version.sh), a re-drive can read "not published",
# publish, and be refused:
#
#   npm error code EPUBLISHCONFLICT
#   npm error Cannot publish over previously published version
#
# A read cannot close that window, because the question "has this been
# published?" is answered by whoever accepts the publish. So this asks the
# registry to DECIDE rather than to remember: the pre-check stays as the cheap
# path, and a publish refused because the version already exists is the same
# outcome as a publish that succeeded — the version is on npm, which is all the
# release needs.
#
# Any other publish failure is still a failure.
#
# Usage:
#   scripts/publish-if-absent.sh <version> [npm publish args…]
#
# Environment:
#   NPM_PACKAGE   package name (default @layr8/sdk)

set -uo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: $0 <version> [npm publish args…]" >&2
  exit 2
fi
shift

PACKAGE="${NPM_PACKAGE:-@layr8/sdk}"

if npm view "$PACKAGE@$VERSION" version >/dev/null 2>&1; then
  echo "$PACKAGE@$VERSION is already on the registry — skipping publish."
  exit 0
fi

if OUTPUT=$(npm publish "$@" 2>&1); then
  echo "$OUTPUT"
  exit 0
fi

echo "$OUTPUT"

if printf '%s' "$OUTPUT" | grep -qiE 'EPUBLISHCONFLICT|cannot publish over'; then
  echo "$PACKAGE@$VERSION was already published — the registry refused a duplicate, which is the outcome this step wants. Treating as published."
  exit 0
fi

exit 1
