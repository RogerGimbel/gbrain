#!/bin/bash
#
# check-privacy.sh — prevent the private OpenClaw fork name from leaking
# into public artifacts.
#
# Local adaptation note: this branch still carries a small number of
# historical local docs that mention the old name. Those files are
# allow-listed so the guard can be wired now without destabilizing the
# GBrain upgrade lane. New source/docs/tests/scripts remain checked.

set -euo pipefail

BANNED_NAME='wintermute'

usage() {
  cat <<EOF
scripts/check-privacy.sh — scan for the banned OpenClaw fork name.

USAGE:
  scripts/check-privacy.sh           Scan all tracked files in the working tree.
  scripts/check-privacy.sh --staged  Scan only files staged for commit.
  scripts/check-privacy.sh --help    Show this message.

Exit codes: 0 clean, 1 banned name found, 2 setup error.
EOF
}

MODE=working
for arg in "$@"; do
  case "$arg" in
    --staged) MODE=staged ;;
    --help|-h) usage; exit 1 ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then
  echo "check-privacy: git not found" >&2
  exit 2
fi

if [ "$MODE" = staged ]; then
  FILES=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)
else
  FILES=$(git ls-files 2>/dev/null || true)
fi

if [ -z "$FILES" ]; then
  exit 0
fi

ALLOW_LIST=(
  'scripts/check-privacy.sh'
  'CLAUDE.md'
  'llms-full.txt'
  'docs/UPGRADING_DOWNSTREAM_AGENTS.md'
  'test/integrations.test.ts'
  # Historical local docs already containing the legacy name before this
  # guard was ported. Keep these explicit so new leaks still fail.
  'CHANGELOG.md'
  'TODOS.md'
)

is_allowed() {
  local f="$1"
  for a in "${ALLOW_LIST[@]}"; do
    if [ "$f" = "$a" ]; then
      return 0
    fi
  done
  return 1
}

FOUND=0
while IFS= read -r file; do
  [ -z "$file" ] && continue
  [ ! -f "$file" ] && continue
  if is_allowed "$file"; then
    continue
  fi
  case "$file" in
    *.md|*.ts|*.mjs|*.js|*.py|*.sh|*.json|*.yaml|*.yml|*.txt|README*|CHANGELOG*|CLAUDE*|AGENTS*)
      if grep -in "$BANNED_NAME" "$file" >/dev/null 2>&1; then
        echo "[check-privacy] BANNED NAME in $file:" >&2
        grep -in "$BANNED_NAME" "$file" | sed 's|^|  |' >&2
        FOUND=1
      fi
      ;;
  esac
done <<< "$FILES"

if [ "$FOUND" -eq 1 ]; then
  echo "" >&2
  echo "The private OpenClaw fork name is banned in public artifacts." >&2
  echo "Replace with 'your OpenClaw', 'OpenClaw reference deployment', or 'openclaw-reference'." >&2
  exit 1
fi

exit 0
