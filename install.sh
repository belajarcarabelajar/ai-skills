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

# 0. Prerequisites Check: tgrep, context-mode, rtk, gh, bun, opencode
check_prereq() {
  local cmd="$1"
  local label="$2"
  local min_hint="${3:-}"

  if ! command -v "$cmd" &>/dev/null; then
    if [ -x "$HOME/.local/bin/$cmd" ]; then
      export PATH="$HOME/.local/bin:$PATH"
    elif [ -x "$HOME/.bun/bin/$cmd" ]; then
      export PATH="$HOME/.bun/bin:$PATH"
    else
      echo "❌ Missing prerequisite: '$cmd' ($label) is mandatory." >&2
      [ -n "$min_hint" ] && echo "   Hint: $min_hint" >&2
      echo "   Install to ~/.local/bin/$cmd, ~/.bun/bin/$cmd, or system PATH." >&2
      exit 1
    fi
  fi
  local version
  version="$($cmd --version 2>&1 | head -n 1)"
  [ -z "$version" ] && version="installed (no version flag)"
  echo "[OK] Prerequisite verified: $cmd — $version"
}

check_prereq "tgrep"        "microsoft/tgrep v1.0.5 (trigram-indexed search)" \
             "curl -fsSL https://raw.githubusercontent.com/microsoft/tgrep/main/install.sh | bash"
check_prereq "bun"          "Bun >= 1.1.0 (mandatory JS/TS runtime; bun install / bun test / bun run)" \
             "curl -fsSL https://bun.sh/install | bash"
check_prereq "context-mode" "Context Mode MCP server (token-efficient routing)" \
             "bun add -g context-mode"
check_prereq "rtk"          "Rust Token Killer (rtk proxy for dev ops)" \
             "cargo install rtk"
check_prereq "gh"           "GitHub CLI (web search GitHub operations)" \
             "sudo pacman -S github-cli  # Arch Linux"
check_prereq "opencode"     "OpenCode AI agent harness (1.x CLI)" \
             "curl -fsSL https://opencode.ai/install | bash"

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

link_skill_package() {
  local target_skill_dir="$1"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY-RUN] Would configure skill package in: $target_skill_dir"
    echo "[DRY-RUN]   - SKILL.md -> $MASTER_FILE"
    echo "[DRY-RUN]   - templates -> $REPO_DIR/templates"
    echo "[DRY-RUN]   - examples -> $REPO_DIR/examples"
  else
    mkdir -p "$target_skill_dir"
    ln -sf "$MASTER_FILE" "$target_skill_dir/SKILL.md"
    ln -sfn "$REPO_DIR/templates" "$target_skill_dir/templates"
    ln -sfn "$REPO_DIR/examples" "$target_skill_dir/examples"
    echo "[OK] Linked skill package in: $target_skill_dir"
  fi
}

# 1. Personal AI config directory (~/.config/ai/)
link_target "$HOME/.config/ai" "$HOME/.config/ai/Super Ultra Code Plan Implementation.md"

# 2. Universal Agent Skills (~/.agents/skills/super-ultra-code-plan/)
link_skill_package "$HOME/.agents/skills/super-ultra-code-plan"

# 3. Gemini / Antigravity User Skills (~/.gemini/config/skills/super-ultra-code-plan/)
link_skill_package "$HOME/.gemini/config/skills/super-ultra-code-plan"

# 4. Antigravity CLI builtin fallback (~/.gemini/antigravity-cli/builtin/skills/)
if [ -d "$HOME/.gemini/antigravity-cli/builtin/skills" ]; then
  link_skill_package "$HOME/.gemini/antigravity-cli/builtin/skills/super-ultra-code-plan"
fi

# 5. Claude Code directory (~/.claude/skills/)
if [ -d "$HOME/.claude" ]; then
  link_skill_package "$HOME/.claude/skills/super-ultra-code-plan"
fi

# 6. Local Repo Self-Check
if [ "$DRY_RUN" = true ]; then
  echo "[DRY-RUN] Would verify internal skill package in: $REPO_DIR/skills/super-ultra-code-plan"
  echo "[DRY-RUN]   - SKILL.md -> ../../Super Ultra Code Plan Implementation.md"
  echo "[DRY-RUN]   - templates -> ../../templates"
  echo "[DRY-RUN]   - examples -> ../../examples"
else
  mkdir -p "$REPO_DIR/skills/super-ultra-code-plan"
  ln -sf "../../Super Ultra Code Plan Implementation.md" "$REPO_DIR/skills/super-ultra-code-plan/SKILL.md"
  ln -sfn "../../templates" "$REPO_DIR/skills/super-ultra-code-plan/templates"
  ln -sfn "../../examples" "$REPO_DIR/skills/super-ultra-code-plan/examples"
  echo "[OK] Internal repo skill package symlinks verified."
fi

echo "==> Ultimate AI Coding Skill installation complete!"
