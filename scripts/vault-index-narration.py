#!/usr/bin/env python3
"""vault-index narration filter

Turns a rendered session transcript into the part a reader can actually read.

Measured on the vault corpus, 2026-10-02: a session transcript is 65-80%
tool-call traffic. That traffic is most of the file's bytes and almost none of
its content. Four separate subagents each shipped their own filter for this and
each shipped a variant of the same bug, so it is a script now.

THE STRUCTURE, verified against real files rather than assumed:

    ## [seq 4] user          <- seq marker; scaffolding, drop its body
    ### prompt               <- NARRATION, keep with its body
    ## [seq 5] assistant
    ### assistant text       <- NARRATION, keep with its body
    ### tool · read          <- scaffolding, drop its body
    #### input               <- scaffolding, drop its body
    #### output              <- scaffolding, drop its body
    ### reasoning            <- NARRATION, keep with its body

The two mistakes that shipped four times, recorded so they are not shipped a
fifth:

  1. The `[seq N]` marker is a HEADING (`## [seq 4] user`), not a bare line. A
     filter that tests the raw line for a leading `[` never sees it.
  2. `reasoning`, `assistant text` and `prompt` are the CONTENT. A filter that
     drops them keeps only tool traffic and reports a plausible small number.

Dropping a heading drops its body until a heading of the same or shallower
level, which is what makes `#### input`'s 60 lines of JSON go away while a
`### reasoning` block's prose survives.

Usage:
    narration_filter.py FILE            # one file
    narration_filter.py FILE --stats    # plus the retention numbers

Output lines are prefixed `NNNNN | ` so a downstream `source_location` stays a
real 1-indexed line number in the ORIGINAL file.
"""

import argparse
import re
import sys

# Scaffold: the heading marks a renderer artifact. Drop it and its body.
SCAFFOLD_EXACT = frozenset(
    {
        "input",
        "output",
        "event data",
        "idle",
        "synthetic",
        "meta",
        "tool result",
        "tool call",
        "summary of",
    }
)
SCAFFOLD_PREFIX = ("tool", "[seq", "[prose fenced", "session-event")

# Narration: authored reasoning. KEEP the heading and everything under it.
NARRATION_EXACT = frozenset(
    {
        "reasoning",
        "assistant text",
        "prompt",
        "user",
        "system",
        "text",
        "summary",
    }
)

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*$")
FENCE_RE = re.compile(r"^(`{3,}|~{3,})")


def classify(title: str) -> str:
    """'sep' | 'scaffold' | 'narration' | 'structure'.

    'sep' is the distinction four earlier attempts got wrong. `## [seq N]
    assistant` is a SEPARATOR at level 2. Treating it as a scaffold opens a drop
    region of level 2, and the next heading is `### reasoning` at level 3, which
    does not clear it -- so every reasoning body in the transcript is silently
    dropped and the filter reports a small, plausible, wrong number. A separator
    emits its line and opens nothing.
    """
    low = " ".join(title.strip().lower().split())
    if low.startswith(("[seq", "[prose fenced")):
        return "sep"
    if low in SCAFFOLD_EXACT or low.startswith(SCAFFOLD_PREFIX):
        return "scaffold"
    if low in NARRATION_EXACT:
        return "narration"
    return "structure"


def filter_text(text: str):
    """Return (kept_lines, stats). kept_lines are 'NNNNN | <line>'."""
    out = []
    stats = {
        "total_lines": 0,
        "kept_lines": 0,
        "tool_traffic_dropped": 0,
        "scaffold_headings": 0,
        "narration_headings": 0,
        "structure_headings": 0,
        "fenced_lines_dropped": 0,
    }

    fence_char = None
    fence_len = 0
    drop_level = None  # inside scaffold: swallow until a heading <= this level

    for lineno, raw in enumerate(text.split("\n"), start=1):
        stats["total_lines"] += 1

        # Inside a fence: a fence line closes only on the same char and at least
        # the same width. Everything else inside is content.
        if fence_char is not None:
            m = FENCE_RE.match(raw)
            if m:
                tok = m.group(1)
                if tok[0] == fence_char and len(tok) >= fence_len:
                    fence_char = fence_len = None
                else:
                    out.append(f"{lineno} | {raw}")
                continue
            if drop_level is not None:
                stats["fenced_lines_dropped"] += 1
                continue
            out.append(f"{lineno} | {raw}")
            continue

        m = FENCE_RE.match(raw)
        if m:
            tok = m.group(1)
            fence_char, fence_len = tok[0], len(tok)
            if drop_level is not None:
                stats["fenced_lines_dropped"] += 1
                continue
            out.append(f"{lineno} | {raw}")
            continue

        h = HEADING_RE.match(raw)
        if h:
            level, title = len(h.group(1)), h.group(2)
            kind = classify(title)
            # Any heading at or above the drop level ends the scaffolded region.
            # The comparison is on the SCAFFOLD heading's own level, not on the
            # transcript's section level, which is why separators open nothing.
            if drop_level is not None and level <= drop_level:
                drop_level = None
            if kind == "scaffold":
                stats["scaffold_headings"] += 1
                drop_level = level
                continue  # the scaffold marker itself is not content
            if kind == "narration":
                stats["narration_headings"] += 1
            else:
                stats["structure_headings"] += 1
            out.append(f"{lineno} | {raw}")
            continue

        if drop_level is not None:
            stats["tool_traffic_dropped"] += 1
            continue

        out.append(f"{lineno} | {raw}")

    stats["kept_lines"] = len(out)
    return out, stats


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("file")
    ap.add_argument("--stats", action="store_true", help="print retention to stderr")
    ap.add_argument("--head", type=int, default=0, help="print only the first N lines")
    a = ap.parse_args(argv)

    # newline='' is REQUIRED, not a style choice. Python's universal-newline
    # handling splits on a bare \r as well as \r\n and \n, so a transcript
    # containing 36 stray carriage returns reports line numbers that are up to
    # 36 too high from that point onward. Measured on one real transcript: the
    # script reported 20957 where the true 1-indexed line was 20921. The
    # `NNNNN | ` prefix exists so a subagent can write a real source_location
    # from it, and every such location downstream of a stray \r was silently
    # wrong. Splitting on '\n' alone keeps the numbering honest for a file whose
    # line endings are already broken.
    with open(a.file, encoding="utf-8", errors="replace", newline="") as fh:
        text = fh.read()

    kept, stats = filter_text(text)
    body = kept if not a.head else kept[: a.head]
    if body:
        sys.stdout.write("\n".join(body) + "\n")

    if a.stats:
        pct = (
            100.0 * stats["kept_lines"] / stats["total_lines"]
            if stats["total_lines"]
            else 0.0
        )
        print(
            f"[narration-filter] {a.file}\n"
            f"  total           {stats['total_lines']:>7}\n"
            f"  kept            {stats['kept_lines']:>7}  ({pct:.1f}%)\n"
            f"  tool traffic    -{stats['tool_traffic_dropped']:>6}\n"
            f"  fenced dropped  -{stats['fenced_lines_dropped']:>6}\n"
            f"  scaffold hdg x{stats['scaffold_headings']:>6}\n"
            f"  narration hdg   {stats['narration_headings']:>6}\n"
            f"  structure hdg   {stats['structure_headings']:>6}",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())