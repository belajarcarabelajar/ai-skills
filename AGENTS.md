## graphify

No knowledge graph has been built in this directory yet: `graphify-out/` does
not exist. The graph is built on demand, so never assume one is present —
check `test -f graphify-out/graph.json` before relying on it.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules (all conditional on `graphify-out/graph.json` existing):
- If it exists, start codebase questions with `graphify query "<question>"`, use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. A scoped subgraph is usually much smaller than GRAPH_REPORT.md or raw grep output.
- If it does not exist, fall back to normal search (`rg`, Read). Never report graph results that were not actually produced.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep an existing graph current (AST-only, no API cost).
