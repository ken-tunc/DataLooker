#!/usr/bin/env bash
# Restores the agent skills skills-lock.json pins. Run from the SessionStart
# hook in ../settings.json, and safe to run by hand.
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-"$(dirname "$0")/../.."}"

# The skills CLI lives in node_modules so the lockfile pins which version runs;
# a fresh clone or a new worktree has none yet.
vp install --frozen-lockfile
node_modules/.bin/skills experimental_install

# `experimental_install` only ever writes to .agents/skills: it restores for the
# agents whose skills directory IS .agents/skills, which Claude Code's is not.
# Link what it restored into the directory Claude Code reads, the way
# `skills add --agent claude-code` would have.
mkdir -p .claude/skills
for skill in .agents/skills/*/; do
  [ -d "$skill" ] || continue
  ln -sfn "../../$skill" ".claude/skills/$(basename "$skill")"
done
