#!/usr/bin/env bash
# scripts/sync.sh — Bidirectional sync helper between repository and ~/.config/ai/
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="$HOME/.config/ai"
FILE_NAME="Super Ultra Code Plan Implementation.md"

ACTION="${1:-status}"

case "$ACTION" in
  status)
    echo "==> Comparing $REPO_DIR/$FILE_NAME with $CONFIG_DIR/$FILE_NAME..."
    if [ -L "$CONFIG_DIR/$FILE_NAME" ]; then
      echo "[INFO] $CONFIG_DIR/$FILE_NAME is a symlink pointing to $(readlink -f "$CONFIG_DIR/$FILE_NAME")"
    elif [ -f "$CONFIG_DIR/$FILE_NAME" ]; then
      diff -u "$REPO_DIR/$FILE_NAME" "$CONFIG_DIR/$FILE_NAME" || true
    else
      echo "[WARN] $CONFIG_DIR/$FILE_NAME does not exist."
    fi
    ;;
  push)
    echo "==> Pushing repo version to $CONFIG_DIR..."
    mkdir -p "$CONFIG_DIR"
    cp "$REPO_DIR/$FILE_NAME" "$CONFIG_DIR/$FILE_NAME"
    echo "[OK] Copied $FILE_NAME to $CONFIG_DIR"
    ;;
  pull)
    echo "==> Pulling changes from $CONFIG_DIR to repo..."
    if [ -f "$CONFIG_DIR/$FILE_NAME" ] && [ ! -L "$CONFIG_DIR/$FILE_NAME" ]; then
      cp "$CONFIG_DIR/$FILE_NAME" "$REPO_DIR/$FILE_NAME"
      echo "[OK] Updated repo from $CONFIG_DIR"
    else
      echo "[INFO] $CONFIG_DIR/$FILE_NAME is a symlink or missing. No pull needed."
    fi
    ;;
  link)
    echo "==> Symlinking repo version into $CONFIG_DIR..."
    mkdir -p "$CONFIG_DIR"
    ln -sf "$REPO_DIR/$FILE_NAME" "$CONFIG_DIR/$FILE_NAME"
    echo "[OK] Symlink established."
    ;;
  *)
    echo "Usage: $0 [status|push|pull|link]"
    exit 1
    ;;
esac
