#!/usr/bin/env bash
#
# Provenance check.
#
# A fixture that a comment describes as "real" is a leak by definition. An
# identifier list can only find what someone already thought to list, so it
# cannot catch a hostname or a person's name nobody enumerated. This looks for
# the vocabulary instead: prose claiming a value came from somewhere real.
#
# It inspects ONLY newly added lines, so previously reviewed comments stay put
# and there is deliberately NO exclusion list — an exclusion is exactly where
# the thing being scanned for would hide.
#
# Usage: scripts/check-provenance.sh <base-ref>
#        scripts/check-provenance.sh --full     (scan whole tree, report only)
#
# Exit 0 clean, 1 hits found, 2 usage error.

set -uo pipefail

VOCAB='real|live|actual|verified|copied from|still works'

# Scope: the shipped node code and the fixtures. That is where captured values
# live, and it is where the 2026-08-05 leak sat (a real relay hostname, four real
# member display names and a real document's filename + hash, all in test/).
# Prose in README/SECURITY legitimately says "a real relay", so scanning docs
# would bury the signal. This is a scope, not an exclusion list: no file is
# skipped because it is known to contain something.
PATHS=(nodes credentials test)

usage() { echo "usage: $0 <base-ref> | --full" >&2; exit 2; }
[ $# -eq 1 ] || usage

report() {
	echo ""
	echo "  Provenance vocabulary found. For each line below, confirm the VALUES it"
	echo "  refers to are synthetic. Describing protocol shape is fine; naming a real"
	echo "  host, person, file or hash is not."
	echo ""
}

if [ "$1" = "--full" ]; then
	echo "provenance check: FULL-TREE MODE (report only, does not fail)"
	hits=$(git grep -inwE "$VOCAB" -- "${PATHS[@]}" || true)
	if [ -n "$hits" ]; then report; printf '%s\n' "$hits"; fi
	exit 0
fi

BASE="$1"
if ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
	echo "provenance check: SKIPPED — '$BASE' is not a commit in this repo."
	echo "  This check did NOT run. Re-run with a valid base ref before trusting it."
	exit 0
fi

added=$(git diff -U0 "$BASE" HEAD -- "${PATHS[@]}" \
	| grep '^+' | grep -v '^+++' | sed 's/^+//' || true)

if [ -z "$added" ]; then
	echo "provenance check: clean (no added lines in scanned file types)"
	exit 0
fi

hits=$(printf '%s\n' "$added" | grep -inwE "$VOCAB" || true)

if [ -n "$hits" ]; then
	report
	printf '%s\n' "$hits"
	echo ""
	echo "  If every value is synthetic, this is a false positive — reword the comment"
	echo "  or confirm and override. Do not add an exclusion list."
	exit 1
fi

echo "provenance check: clean ($(printf '%s\n' "$added" | wc -l | tr -d ' ') added lines scanned)"
exit 0
