#!/usr/bin/env bash
#
# Fails when text that only makes sense inside the organisation is about to
# become public.
#
# This exists because it already happened. Versions 0.2.2 and 0.2.3 of this
# package shipped doc comments naming a private repository, its policy source
# files, an internal ticket and a developer's home directory. They reached npm
# because nothing looked, and the vector was not the source tree: TypeScript
# compiles doc comments into `dist/*.d.ts`, so the comments were installed into
# every consumer's `node_modules`. Scanning source alone would not have caught
# it — hence `--tarball`, which runs on the artifact that is actually published.
#
# Modes:
#   --diff <base>      added lines of HEAD against <base>   (pull requests)
#   --tree             every tracked file                   (whole-repo audit)
#   --tarball <file>   contents of a packed artifact        (before publishing)
#                      accepts a .tgz/.tar.gz or a .whl/.zip
#
# Two classes of check:
#
#   Structural — file paths that only resolve on a developer's machine, private
#   network addresses, internal hostnames, ticket identifiers, policy source
#   files, cloud account identifiers. Always on. Nothing about these patterns
#   discloses anything, so they live in this file.
#
#   Named — internal service and repository names, supplied through the
#   INTERNAL_NAMES environment variable, one per line. The list is NOT committed
#   here: an enumeration of the organisation's private repositories would itself
#   be the kind of disclosure this script prevents. Without it the named check
#   is skipped, and says so rather than passing quietly.
#
#   In CI that comes from a repository VARIABLE, not a secret. The names are not
#   credentials, and a secret's value is masked in the log — which turns the one
#   line you need to read, the matched name, into ***.
#
# Escape hatch: a line containing `hygiene-ok:` is exempt. It stays in the diff
# on purpose, so a reviewer sees the claim being made.

set -uo pipefail

MODE=""; ARG=""
case "${1:-}" in
  --diff)    MODE=diff;    ARG="${2:-}" ;;
  --tree)    MODE=tree ;;
  --tarball) MODE=tarball; ARG="${2:-}" ;;
  *) echo "usage: $0 --diff <base> | --tree | --tarball <file>" >&2; exit 64 ;;
esac

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
subject="$work/subject.txt"

case "$MODE" in
  diff)
    [ -n "$ARG" ] || { echo "--diff needs a base ref" >&2; exit 64; }
    # Added lines only. Deleting a leak must never fail the check, or the fix
    # for a leak becomes unmergeable.
    git diff "$ARG"...HEAD -- . \
      | grep -E '^\+' | grep -vE '^\+\+\+' | sed 's/^+//' > "$subject" || true
    ;;
  tree)
    # A newline after each file, or a minified bundle merges with the next file
    # and every reported "line" is a megabyte long.
    git ls-files -z | while IFS= read -r -d '' f; do
      cat "$f" 2>/dev/null; echo
    done > "$subject" || true
    ;;
  tarball)
    [ -f "$ARG" ] || { echo "no such artifact: $ARG" >&2; exit 64; }
    mkdir -p "$work/x"
    case "$ARG" in
      *.whl|*.zip) unzip -qq "$ARG" -d "$work/x" ;;
      *)           tar xzf "$ARG" -C "$work/x" ;;
    esac
    # File names matter as much as contents: a path is a leak whether it is
    # inside a comment or is the name of the file shipped.
    (cd "$work/x" && find . -type f -print) > "$subject"
    find "$work/x" -type f -print0 | while IFS= read -r -d '' f; do
      cat "$f" 2>/dev/null; echo
    done >> "$subject" || true
    ;;
esac

# Strip exempted lines before any check runs.
grep -v 'hygiene-ok:' "$subject" > "$subject.f" 2>/dev/null && mv "$subject.f" "$subject"

if [ ! -s "$subject" ]; then
  echo "hygiene: nothing to check."
  exit 0
fi

fail=0
# Minified bundles and source maps have no line breaks, so a raw match can be a
# megabyte wide. Report enough to find it and no more.
report() { fail=1; printf '::error::%s\n' "$1"; printf '%s\n' "$2" | cut -c1-160; }

# ---------------------------------------------------------------- structural
scan() {
  local label="$1" pattern="$2" hit
  hit="$(grep -inE "$pattern" "$subject" 2>/dev/null | head -5)" || true
  [ -n "$hit" ] && report "$label" "$(printf '%s' "$hit" | sed 's/^/    /')"
}

# Case-sensitive variant, for patterns whose case carries meaning.
scanC() {
  local label="$1" pattern="$2" hit
  hit="$(grep -nE "$pattern" "$subject" 2>/dev/null | head -5)" || true
  [ -n "$hit" ] && report "$label" "$(printf '%s' "$hit" | sed 's/^/    /')"
}

scan "developer home directory"  '(^|[^[:alnum:]])(/Users/|/home/)[a-z][a-z0-9._-]+/'
# The tilde form, which is how the original leak was written. Paths under a
# dotted directory (`~/.npmrc`, `~/.config/…`) are ordinary user instructions
# and are not matched.
scan "home-relative path"        '~/[A-Za-z][A-Za-z0-9._-]*/'
scan "private network address"   '(^|[^0-9.])(10\.[0-9]{1,3}|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3}'
scan "internal hostname"         '[a-z0-9-]+\.(internal\.[a-z0-9.-]+|svc\.cluster\.local)'
# Case-sensitive, unlike the rest. A ticket identifier is upper-case; the
# package name is not. Matched case-insensitively, a lower-case package name
# followed by a version number reads as a ticket and fails every build.
scanC "issue tracker identifier" '(^|[^[:alnum:]])LAYR8-[0-9]{1,6}([^0-9]|$)'
# Not preceded by a dot: `credentialSubject.constraints.rego` is a field path
# inside a credential, which every user of this library can see, and flagging it
# would make the check fail on correct documentation.
scan "policy source file"        '(^|[^a-zA-Z0-9._])[a-z0-9_]+\.rego([^a-z0-9]|$)'
scan "cloud account identifier"  '(arn:aws:[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}:|(^|[^0-9])[0-9]{12}\.dkr\.ecr\.)'

# --------------------------------------------------------------------- named
#
# Whether a matched name may be printed. A public repository's workflow logs are
# public too, and "that word is on our internal roster" is something the diff
# alone does not say — so in Actions the name, the line and the file all stay
# out of the output, and the developer reproduces locally, where it is private.
# Everywhere else, print everything: that is where the check is useful.
quiet_names=0
[ -n "${GITHUB_ACTIONS:-}" ] && quiet_names=1
[ "${HYGIENE_SHOW_NAMES:-}" = 1 ] && quiet_names=0

if [ -n "${INTERNAL_NAMES:-}" ]; then
  checked=0
  named_hits=0
  while IFS= read -r name; do
    name="$(printf '%s' "$name" | tr -d '[:space:]')"
    [ -n "$name" ] || continue
    [ "${#name}" -ge 4 ] || continue
    checked=$((checked + 1))
    hit="$(grep -inE "(^|[^[:alnum:]_-])${name}([^[:alnum:]_-]|\$)" "$subject" 2>/dev/null | head -3)" || true
    [ -n "$hit" ] || continue
    named_hits=$((named_hits + 1))
    if [ "$quiet_names" = 1 ]; then
      fail=1
    else
      report "internal system name" "$(printf '%s' "$hit" | sed 's/^/    /')"
    fi
  done <<< "$INTERNAL_NAMES"
  echo "hygiene: checked $checked internal names."

  if [ "$quiet_names" = 1 ] && [ "$named_hits" -gt 0 ]; then
    printf '::error::%s internal system name(s) in the added lines.\n' "$named_hits"
    echo "  The name, the line and the file are not printed here on purpose: this"
    echo "  repository is public and so is this log."
    echo
    echo "  To see which name and where, run the same check locally, where the"
    echo "  output goes only to you:"
    echo
    printf '    INTERNAL_NAMES="$(gh variable get INTERNAL_NAMES --repo %s)" \\\n' "${GITHUB_REPOSITORY:-<org>/<repo>}"
    echo "      ./scripts/check-public-hygiene.sh --diff origin/main"
    echo
    echo "  The team's pre-commit hooks run the same check, with full detail,"
    echo "  before you commit. Ask a maintainer where to get them."
  fi
else
  echo "::notice::INTERNAL_NAMES is not set, so internal service and repository"
  echo "::notice::names were not checked. Structural patterns were. Set the"
  echo "::notice::INTERNAL_NAMES repository variable to enable the named check."
fi

if [ "$fail" = 1 ]; then
  cat >&2 <<'EOF'

This repository is public. Something in the added lines names a system that
only resolves inside the organisation: a reader outside it cannot follow the
reference, and it discloses the shape of infrastructure that is not published.

Describe the behaviour instead of where it lives. "the node's authorization
policy allows on the first passing grant" says everything a user needs; naming
the file that implements it says something only an insider can use.

If a reference genuinely belongs here, put `hygiene-ok: <reason>` on the same
line so the exemption is visible in review.
EOF
  exit 1
fi

echo "hygiene: clean."
