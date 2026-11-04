#!/usr/bin/env bash
# sync-upstream.sh — fork-only: keep swjac/gstack main = garrytan/gstack main + the Gemini outside reviewer.
#
# Run daily by the Windows scheduled task "gstack-upstream-sync" against the global install
# (~/.claude/skills/gstack, a clone of the fork). It merges upstream main, runs the Gemini tests,
# and only then pushes the fork and refreshes the install. A merge conflict or a failed test
# leaves the install on its last good commit and says why in the log. Never rebases: every
# update stays a fast-forward for /gstack-upgrade.
#
# Usage: sync-upstream.sh [checkout]   (default ~/.claude/skills/gstack)
set -uo pipefail
DIR="${1:-$HOME/.claude/skills/gstack}"
LOG="$HOME/.gstack/fork-sync.log"
mkdir -p "$(dirname "$LOG")"
export PATH="$HOME/.bun/bin:$HOME/AppData/Local/Programs/gh/bin:$HOME/.local/bin:$PATH"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }
fail() { say "FAILED: $*"; exit 1; }

cd "$DIR" || fail "no checkout at $DIR"
[ "$(git branch --show-current)" = main ] || fail "checkout is not on main"
git diff --quiet && git diff --cached --quiet || fail "checkout has uncommitted changes to tracked files; not touching it"
git remote get-url upstream >/dev/null 2>&1 || git remote add upstream https://github.com/garrytan/gstack.git
git fetch -q origin main && git fetch -q upstream main || fail "fetch failed (network or auth)"

# Pick up anything pushed to the fork from elsewhere first; local main never has unpushed work.
git merge -q --ff-only origin/main || fail "local main diverged from origin/main; resolve by hand"
if git merge-base --is-ancestor upstream/main HEAD; then say "up to date with upstream ($(git rev-parse --short upstream/main))"; exit 0; fi

GOOD=$(git rev-parse HEAD)
if ! git -c user.name="gstack fork sync" merge -q --no-edit -m "Merge upstream garrytan/gstack main [skip ci]" upstream/main; then
  git merge --abort 2>/dev/null
  fail "merge conflict with upstream $(git rev-parse --short upstream/main); install stays at $(git rev-parse --short "$GOOD"). Resolve in a clone: git merge upstream/main"
fi
if ! bun install --frozen-lockfile >/dev/null 2>&1 || ! bun test test/gemini-outside-voice.test.ts >>"$LOG" 2>&1; then
  git reset -q --hard "$GOOD"
  fail "Gemini tests fail on upstream $(git rev-parse --short upstream/main); install rolled back to $(git rev-parse --short "$GOOD")"
fi
git push -q origin main || { git reset -q --hard "$GOOD"; fail "push to the fork failed; rolled back to $(git rev-parse --short "$GOOD")"; }
./setup --refresh-registered </dev/null >>"$LOG" 2>&1 || fail "setup failed after merging $(git rev-parse --short upstream/main); see the log above"
say "merged upstream $(git rev-parse --short upstream/main); install at $(git rev-parse --short HEAD) $(cat VERSION)"
