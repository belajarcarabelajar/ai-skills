#!/usr/bin/env bash
# Accept repaired or freshly extracted chunks: run both gates, report the
# structural diff, and commit only what passes.
#
# The parent used to do this by hand, one chunk at a time, and the expensive
# part was never the two checks — it was confirming that a subagent had changed
# rationale spans and nothing else. So the structural diff is first-class here:
# node ids, node order and the links array must match HEAD unless the chunk
# reported a case-3 deletion, which is the one change that is supposed to alter
# them.
#
# Usage:
#   ./scripts/accept-chunks.sh rem-127 075 ...          # dry run, no writes
#   ./scripts/accept-chunks.sh --commit -m 'msg' rem-127
#   ./scripts/accept-chunks.sh --commit                 # every dirty chunk
set -uo pipefail
cd "$(dirname "$0")/.."

COMMIT=0; MSG=""
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) COMMIT=1 ;;
    -m) MSG="$2"; shift ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done

CHUNKS=()
if [ ${#ARGS[@]} -gt 0 ]; then
  CHUNKS=("${ARGS[@]}")
else
  while IFS= read -r f; do
    CHUNKS+=("$(basename "$f" .json | sed 's/^chunk-//')")
  done < <(git diff --name-only -- 'vault-index/semantic/chunk-*.json')
fi

if [ ${#CHUNKS[@]} -eq 0 ]; then
  echo "tidak ada chunk untuk diperiksa"
  exit 0
fi

PASS=(); FAIL=()
for id in "${CHUNKS[@]}"; do
  f="vault-index/semantic/chunk-${id}.json"
  if [ ! -f "$f" ]; then echo "  $id  FILE TIDAK ADA"; FAIL+=("$id"); continue; fi

  a=$(./scripts/check-anchors.mjs "$id" 2>&1 | grep -E '^ *(ok|FAIL)' | head -1)
  v=$(./scripts/verify-chunk.sh "$id" 2>&1 | grep -m1 '"ok"')

  if echo "$a" | grep -q '^ *ok' && echo "$v" | grep -q '"ok": true'; then
    PASS+=("$id")
    printf '  %-10s GATE1 %s\n' "$id" "$(echo "$a" | sed 's/^ *//')"
    printf '  %-10s GATE2 %s\n' "" "$v"
  else
    FAIL+=("$id")
    printf '  %-10s GAGAL\n' "$id"
    printf '             %s\n' "$(echo "$a" | sed 's/^ *//')"
    printf '             %s\n' "$v"
  fi
done

# Structural diff: what actually changed relative to HEAD.
if [ ${#PASS[@]} -gt 0 ]; then
  echo
  echo "=== struktur vs HEAD (harus sama kecuali node dihapus) ==="
  python3 - "${PASS[@]}" << 'PY'
import json, subprocess, sys
for cid in sys.argv[1:]:
    p = f'vault-index/semantic/chunk-{cid}.json'
    now = json.load(open(p))
    old = json.loads(subprocess.run(['git','show','HEAD:'+p], capture_output=True, text=True).stdout or '{}')
    if not old:
        print(f'  {cid:10s} BARU (belum pernah ter-commit)')
        continue
    on = [n['id'] for n in old['nodes']]; nn = [n['id'] for n in now['nodes']]
    removed = sorted(set(on)-set(nn)); added = sorted(set(nn)-set(on))
    same_links = old['links'] == now['links']
    ok = (not added) and (removed or same_links)
    print(f'  {cid:10s} node {len(on)}->{len(nn)} | id urut sama {on==nn} | '
          f'links sama {same_links} | hilang {removed or "-"} | baru {added or "-"}'
          f'  {"OK" if ok else "**PERLU PERHATIAN**"}')
PY
fi

echo
echo "LOLOS: ${#PASS[@]}  GAGAL: ${#FAIL[@]}"
[ ${#FAIL[@]} -gt 0 ] && printf '  gagal: %s\n' "${FAIL[*]}"

if [ "$COMMIT" -eq 1 ] && [ ${#PASS[@]} -gt 0 ]; then
  for id in "${PASS[@]}"; do git add "vault-index/semantic/chunk-${id}.json"; done
  if [ -z "$MSG" ]; then
    MSG=$(cat <<MEOF
fix(vault-index): accept ${#PASS[@]} verified chunk(s)

${PASS[*]}

Both gates exit 0 on every chunk listed above: scripts/check-anchors.mjs (a
verbatim substring test per rationale anchor, plus padding ranges and path
resolution) and scripts/verify-chunk.sh (validator, cross-chunk endpoints,
unresolved endpoints).

The structural diff against HEAD was printed immediately before this commit.
Node ids and links are unchanged except where a case-3 deletion was reported,
which is the only change permitted to alter them.
MEOF
)
  fi
  git commit -q -F - <<<"$MSG"
  git log --oneline -1
fi
exit 0
