#!/usr/bin/env bash
# scripts/render-diagrams.sh — Extract all mermaid blocks from .md files and render to SVG
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$REPO_DIR/diagrams"
TEMP_DIR="$REPO_DIR/.mermaid-tmp"

mkdir -p "$OUTPUT_DIR" "$TEMP_DIR"

# Resolve mmdc binary (from local node_modules or PATH)
if [ -f "$REPO_DIR/node_modules/.bin/mmdc" ]; then
  MMDC="$REPO_DIR/node_modules/.bin/mmdc"
elif command -v mmdc &>/dev/null; then
  MMDC="mmdc"
else
  echo "❌ mmdc not found. Run: bun install (or npm install)" >&2
  exit 1
fi

echo "==> Using mmdc: $MMDC"
echo "==> Rendering mermaid diagrams to: $OUTPUT_DIR"

errors=0
rendered=0

# Find all markdown files in repo
while IFS= read -r mdfile; do
  rel="${mdfile#"$REPO_DIR/"}"
  # Derive base name for output files (replace / and spaces with -)
  base="$(echo "$rel" | sed 's|/|-|g; s|\.md$||; s| |-|g; s|[^a-zA-Z0-9_-]|-|g' | tr '[:upper:]' '[:lower:]')"

  # Extract mermaid blocks using awk
  block_index=0
  inside=0
  current_block=""

  while IFS= read -r line; do
    if [[ "$line" == '```mermaid' ]]; then
      inside=1
      current_block=""
    elif [[ "$line" == '```' && $inside -eq 1 ]]; then
      inside=0
      block_index=$((block_index + 1))
      # Write block to temp file
      tmp_file="$TEMP_DIR/${base}-block${block_index}.mmd"
      echo "$current_block" > "$tmp_file"

      # Determine output SVG name
      # Special case: lifecycle diagram in README gets canonical name
      if [[ "$rel" == "README.md" && $block_index -eq 1 ]]; then
        svg_name="lifecycle"
      else
        svg_name="${base}-block${block_index}"
      fi
      svg_out="$OUTPUT_DIR/${svg_name}.svg"

      echo "  Rendering: $rel [block $block_index] -> diagrams/${svg_name}.svg"
      if "$MMDC" --input "$tmp_file" --output "$svg_out" --backgroundColor transparent 2>&1; then
        rendered=$((rendered + 1))
      else
        echo "  ❌ FAILED: $rel [block $block_index]" >&2
        errors=$((errors + 1))
      fi
    elif [[ $inside -eq 1 ]]; then
      if [[ -z "$current_block" ]]; then
        current_block="$line"
      else
        current_block="$current_block
$line"
      fi
    fi
  done < "$mdfile"
done < <(find "$REPO_DIR" \
  -name "*.md" \
  -not -path "*/node_modules/*" \
  -not -path "*/.git/*" \
  -not -path "*/diagrams/*" \
  | sort)

# Cleanup temp files
rm -rf "$TEMP_DIR"

echo ""
echo "==> Rendered: $rendered diagram(s)"

if [[ $errors -gt 0 ]]; then
  echo "❌ $errors rendering error(s). Check output above." >&2
  exit 1
else
  echo "✅ All diagrams rendered successfully to diagrams/"
fi
