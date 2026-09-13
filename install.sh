#!/usr/bin/env bash
# install.sh — Setup symlinks for the Ultimate All-in-One AI Coding Agent Skill
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MASTER_FILE="$REPO_DIR/Super Ultra Code Plan Implementation.md"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      echo "Usage: ./install.sh [--dry-run]"
      echo "Links the master skill into ~/.config/ai, ~/.agents/skills, ~/.gemini, and ~/.claude."
      exit 0
      ;;
  esac
done

echo "==> Configuring Ultimate All-in-One AI Coding Agent Skill..."
echo "    Source: $MASTER_FILE"

link_target() {
  local target_dir="$1"
  local target_file="$2"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY-RUN] Would create directory: $target_dir"
    echo "[DRY-RUN] Would link: $target_file -> $MASTER_FILE"
  else
    mkdir -p "$target_dir"
    ln -sf "$MASTER_FILE" "$target_file"
    echo "[OK] Linked: $target_file -> $MASTER_FILE"
  fi
}

# 1. Personal AI config directory (~/.config/ai/)
link_target "$HOME/.config/ai" "$HOME/.config/ai/Super Ultra Code Plan Implementation.md"

# 2. Universal Agent Skills (~/.agents/skills/super-ultra-code-plan/)
link_target "$HOME/.agents/skills/super-ultra-code-plan" "$HOME/.agents/skills/super-ultra-code-plan/SKILL.md"

# 3. Antigravity CLI builtin skills (~/.gemini/antigravity-cli/builtin/skills/)
if [ -d "$HOME/.gemini/antigravity-cli/builtin/skills" ]; then
  link_target "$HOME/.gemini/antigravity-cli/builtin/skills/super-ultra-code-plan" "$HOME/.gemini/antigravity-cli/builtin/skills/super-ultra-code-plan/SKILL.md"
fi

# 4. Claude Code directory (~/.claude/skills/)
if [ -d "$HOME/.claude" ]; then
  link_target "$HOME/.claude/skills/super-ultra-code-plan" "$HOME/.claude/skills/super-ultra-code-plan/SKILL.md"
fi

# 5. Local Repo Self-Check
mkdir -p "$REPO_DIR/skills/super-ultra-code-plan"
ln -sf "../../Super Ultra Code Plan Implementation.md" "$REPO_DIR/skills/super-ultra-code-plan/SKILL.md"
echo "[OK] Internal repo skill symlink verified."

echo "==> Ultimate AI Coding Skill installation complete!"
