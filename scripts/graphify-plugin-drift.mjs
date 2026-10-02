// scripts/graphify-plugin-drift.mjs
//
// Does `.opencode/plugins/graphify.js` still hold what a human decided it should
// hold — and if not, what exactly changed?
//
// `graphify install --project --platform opencode` writes THREE things into a
// project: the `## graphify` section of `AGENTS.md`, this plugin file, and
// `.opencode/opencode.json`. `scripts/agents-md-current.mjs` guards the first of
// those three against the installed package. Nothing guarded the second, which is
// this file's job.
//
// WHY, measured 2026-10-02 in ai-skills:
//
// Running the installer here overwrote the committed plugin (−30/+16) and created
// `.opencode/opencode.json`. That overwrite was a REGRESSION, not an upgrade:
//
//   1. The vendored 0.9.73 plugin's own header comment says the hook "prepends
//      `echo "<reminder>" && <cmd>`" while its code concatenates `; `. The
//      comment contradicts the code, and the code is the correct one — the same
//      file explains one line later that Windows PowerShell 5.1 rejects `&&`.
//   2. It deleted a hand-written NOTE recording that a bare `.js` file under
//      `.opencode/plugins/` has no `node_modules` to resolve `@opencode/plugin`
//      from, so a plain default export is required. That is institutional
//      knowledge: a future session re-deriving it gets "Cannot find package" and
//      has no way to know the answer was already written down.
//   3. It changed the exported shape from `{ id, setup(ctx) }` to
//      `export const GraphifyPlugin = async ({ directory }) => ({...})`, whose
//      compatibility with the installed OpenCode is UNVERIFIED.
//
// The files were reverted and only the `AGENTS.md` section was kept — because
// that section is strictly better than what the installer had. The plugin was
// reverted because it is not. But `graphify install --project` re-applies the
// regression silently, and until this module existed nothing said so.
//
// THREE RULES THAT SHAPE THE IMPLEMENTATION:
//
//   - REPORT, NEVER REPAIR. Rewriting the plugin to "fix" drift is precisely the
//     destructive act being guarded against, and a checker that silently repairs
//     cannot report that it found anything. This module has no write path at all;
//     a test asserts the local file's bytes are unchanged after a call.
//
//   - `drift` IS A LIST OF NAMED DIFFERENCES, NOT A BOOLEAN. "It differs" is a
//     shrug. "It differs because the @opencode/plugin NOTE was deleted" is a
//     decision someone can make. The categories below are the ones that actually
//     changed the file's behaviour, and a first-differing-line fallback means
//     `drift` is never empty while the two texts disagree.
//
//   - A DETECTOR THAT INVENTS DRIFT IS WORSE THAN NONE. Every pattern below is
//     anchored, and the self-contradiction check specifically must NOT fire on
//     the local file's `// ';' not '&&'` comment, which mentions `&&` in order to
//     rule it out. A false alarm here trains people to run the installer.
//
// Discovery mirrors `discoverAlwaysOnBlock()` in agents-md-current.mjs: resolve
// the `graphify` executable, `realpath` past the shim, two levels up is the uv
// tool root, then enumerate `lib/python<XY>/site-packages/graphify/`. The
// interpreter minor version is enumerated, never interpolated, because it is uv's
// choice. A hardcoded fallback is exported as a constant, for the same reason and
// with the same caveat: it is a fallback, not the primary lookup.
//
// REVERT: delete this file and its test. Nothing else imports them.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { normalise } from './agents-md-current.mjs';

/**
 * Fallback location of the installed graphify package.
 *
 * Re-exported rather than re-spelled: a second copy of this path would be a
 * second thing to forget when graphifyy is reinstalled against a different
 * interpreter. The caveat travels with it from agents-md-current.mjs — it moves
 * without any visible sign, so treat it as a floor and let the discovered lookup
 * win.
 */
export { UV_TOOL_SITE_PACKAGES } from './agents-md-current.mjs';

import { UV_TOOL_SITE_PACKAGES } from './agents-md-current.mjs';

/**
 * Locate the Python module that OWNS the plugin text.
 *
 * The vendored plugin is not a file. It is the `_OPENCODE_PLUGIN_JS` string
 * constant inside `graphify/install.py`, written out by
 * `_install_opencode_plugin()`. So the analogue of `ALWAYS_ON_BLOCK` is a
 * constant inside a source file, and locating it means locating `install.py` and
 * then reading the literal — which is why this returns a path and `vendoredPlugin()`
 * does the extraction.
 *
 * Same three-part search as the sibling: the resolved executable's uv tool root,
 * every `python<XY>` under it, then the exported fallback.
 *
 * @returns {string} an existing path if one was found, else the fallback — never
 *   null, so a caller can name the place it looked instead of crashing before it
 *   has a sentence to report.
 */
export function discoverPluginSource() {
  const found = [];

  const which = spawnSync('which', ['graphify'], { encoding: 'utf8' });
  const shim = String(which.stdout ?? '').split('\n')[0]?.trim();
  if (shim) {
    let exe = shim;
    try {
      exe = fs.realpathSync(shim);
    } catch {
      // A dangling or unreadable shim is not fatal: the fallback may still be
      // right, and throwing here would hide the very path we want to report.
    }
    const toolRoot = path.dirname(path.dirname(exe));
    let pythonDirs = [];
    try {
      pythonDirs = fs.readdirSync(path.join(toolRoot, 'lib'));
    } catch {
      pythonDirs = [];
    }
    for (const dir of pythonDirs.filter((d) => /^python\d/.test(d)).sort().reverse()) {
      found.push(path.join(toolRoot, 'lib', dir, 'site-packages', 'graphify', 'install.py'));
    }
  }

  found.push(path.join(UV_TOOL_SITE_PACKAGES, 'graphify', 'install.py'));
  return found.find((p) => fs.existsSync(p)) ?? found[found.length - 1];
}

/**
 * Path to the module holding `_OPENCODE_PLUGIN_JS`, resolved at import.
 *
 * Exported so a report can name its reference: a drift verdict that does not say
 * which install.py it read is not reproducible.
 */
export const PLUGIN_SOURCE = discoverPluginSource();

/** Named in a thrown error so the stack says which module threw. */
const TAG = 'graphify-plugin-drift';

/** The Python constant that holds the plugin source, and where it is written to. */
export const VENDORED_CONSTANT = '_OPENCODE_PLUGIN_JS';
export const PLUGIN_RELATIVE_PATH = path.join('.opencode', 'plugins', 'graphify.js');
export const CONFIG_RELATIVE_PATH = path.join('.opencode', 'opencode.json');

/**
 * Python string escapes we know how to undo, and how.
 *
 * Only these are handled. An escape outside this set THROWS rather than passing
 * through: silently leaving `\|` as `\|` would make the extracted plugin differ
 * from the real one by characters nobody can see in a diff, and every verdict
 * built on it would be confidently wrong. A loud failure at extraction is the
 * cheap outcome.
 */
const SIMPLE_ESCAPES = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" };

/**
 * Extract the `_OPENCODE_PLUGIN_JS` literal out of a copy of `install.py`.
 *
 * The literal is a `"""..."""` triple-quoted string. Three details that are not
 * optional:
 *
 *   - The opening is `"""\` followed by a newline. That trailing backslash is a
 *     Python line continuation INSIDE the string, so the real value starts at
 *     `// graphify OpenCode plugin`, not at an empty line. Keeping it would make
 *     every comparison wrong in the first character and the reason invisible.
 *   - Termination is scanned with escapes already resolved, so a `\"` inside the
 *     JS cannot be mistaken for the closing delimiter.
 *   - `_KILO_PLUGIN_JS` also matches a `"""` scan, so the anchor is the constant
 *     NAME. Anchoring on the delimiter alone returns the Kilo plugin — same shape,
 *     different platform, silently wrong.
 *
 * A raw prefix (`r"""`) is supported because it is a one-token difference and its
 * semantics differ materially: in a raw string a backslash-newline is kept
 * literally instead of continuing the line.
 *
 * @param {string} source text of install.py
 * @returns {string} the plugin source graphify would write
 */
export function extractVendoredPlugin(source) {
  if (typeof source !== 'string') {
    throw new Error(`${TAG}: install.py source must be a string, got ${typeof source}`);
  }

  // Match the assignment, optionally prefixed (`_`, `__`) and optionally raw.
  const assign = new RegExp(`(?:^|\\n)[ \\t]*${VENDORED_CONSTANT}[ \\t]*(:[^=]*)?=[ \\t]*(r?)"""`);
  const m = assign.exec(source);
  if (!m) {
    throw new Error(`${TAG}: no ${VENDORED_CONSTANT} triple-quoted literal found; graphify may have moved the plugin to a file`);
  }

  const raw = m[2] === 'r';
  let i = m.index + m[0].length;
  let out = '';

  while (i < source.length) {
    const ch = source[i];

    if (ch === '\\') {
      const next = source[i + 1];
      if (next === undefined) {
        throw new Error(`${TAG}: ${VENDORED_CONSTANT} ends with a dangling backslash`);
      }
      if (next === '\n') {
        // Line continuation. A raw string keeps both characters.
        out += raw ? '\\\n' : '';
        i += 2;
        continue;
      }
      if (next === '\r' && source[i + 2] === '\n') {
        out += raw ? '\\\r\n' : '';
        i += 3;
        continue;
      }
      if (!raw && Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, next)) {
        out += SIMPLE_ESCAPES[next];
        i += 2;
        continue;
      }
      // Unknown escape in a raw string is literal and fine; in a normal one we
      // do not know what Python would have produced.
      if (raw) {
        out += ch + next;
        i += 2;
        continue;
      }
      throw new Error(`${TAG}: unhandled Python escape \\${next} inside ${VENDORED_CONSTANT}; refusing to guess`);
    }

    if (ch === '"' && source[i + 1] === '"' && source[i + 2] === '"') return out;
    out += ch;
    i += 1;
  }

  throw new Error(`${TAG}: ${VENDORED_CONSTANT} is never closed by a """ delimiter`);
}

/**
 * The plugin text a fresh `graphify install --project` would write.
 *
 * @param {object} [opts]
 * @param {string} [opts.sourcePath] defaults to the discovered `install.py`; a
 *   test passes a fixture here so it never depends on the installed wording.
 * @param {string} [opts.source] pre-read source text, for the same reason.
 * @returns {string}
 */
export function vendoredPlugin(opts = {}) {
  if (typeof opts.source === 'string') return extractVendoredPlugin(opts.source);

  const sourcePath = opts.sourcePath ?? PLUGIN_SOURCE;
  let source;
  try {
    source = fs.readFileSync(sourcePath, 'utf8');
  } catch (err) {
    throw new Error(`${TAG}: cannot read ${sourcePath}: ${err.message}`, { cause: err });
  }
  return extractVendoredPlugin(source);
}

/**
 * The committed plugin file for a repo, or null when there is none.
 *
 * Returns the text, not a verdict: absence and content are different states and
 * the caller decides what they mean. A missing file is not an error — a project
 * that never ran the installer has no plugin, and that is a fact to report, not
 * a crash to raise.
 *
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function localPlugin(repoRoot) {
  const file = path.join(repoRoot, PLUGIN_RELATIVE_PATH);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return null;
    throw new Error(`${TAG}: cannot read ${file}: ${err.message}`, { cause: err });
  }
}

/**
 * The `@opencode/plugin` NOTE, recognised by what it says rather than by the
 * whole block.
 *
 * Anchored on the package name and not on `NOTE`, because `NOTE` is the weakest
 * possible anchor: it matches any comment in any file, so a future unrelated note
 * would satisfy the check and the drift would go unreported.
 */
const PLUGIN_PACKAGE_NOTE = /@opencode\/plugin/;

/**
 * Classify a plugin's exported shape.
 *
 * The two shapes that actually differ between versions:
 *
 *   - `default-object` — `export default { id, async setup(ctx) }`, the OpenCode
 *     v2 plugin object. Requires no import, which is why the NOTE matters.
 *   - `named-async-fn` — `export const GraphifyPlugin = async ({ directory }) =>`,
 *     a factory. Also needs no import, so this classifier deliberately says
 *     nothing about whether the installed OpenCode accepts it. UNVERIFIED is not
 *     a verdict this module gets to issue, and pretending otherwise would put an
 *     assertion in a comment where nobody checks it.
 *
 * `unknown` exists so an unrecognised shape is visible as itself rather than
 * silently filed under one of the two known ones.
 */
export function exportShape(text) {
  if (typeof text !== 'string') return 'unknown';
  const named = /export\s+const\s+\w+\s*=\s*async\s*\(/;
  const obj = /export\s+default\s*\{/;
  if (named.test(text)) return 'named-async-fn';
  if (obj.test(text)) return 'default-object';
  return 'unknown';
}

/**
 * Does a plugin's header comment claim `&&` while its code uses `;`?
 *
 * This is the #1646 contradiction, and it is self-contained: the file explains,
 * a few lines apart, both the rule it follows and a reason the other one is
 * wrong. A reader who trusts the comment writes broken PowerShell.
 *
 * The comment side is `&&` in a line that does NOT rule it out. Without that
 * exclusion the detector fires on the correct comment — `// ';' not '&&'` — which
 * is exactly how a guard like this becomes noise nobody runs.
 *
 * The code side is a `;` used as a statement separator inside a concatenation
 * (`" ; ' +` / `'; ' +`), which is what the plugin actually builds.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function headerContradictsCode(text) {
  if (typeof text !== 'string') return false;

  const lines = text.split('\n');
  const comments = lines.filter((l) => /^\s*\/\//.test(l));
  const code = lines.filter((l) => !/^\s*\/\//.test(l));

  const claimsAnd = comments.some((l) => l.includes('&&') && !/not\s+[`'"]?&&/i.test(l));
  const usesSemi = code.some((l) => /["']\s*;\s*["']\s*\+/.test(l));

  return claimsAnd && usesSemi;
}

/** Named drift categories. Exported so a test can assert on the category, not prose. */
export const DRIFT = {
  NOTE_MISSING: 'note-missing',
  SHAPE: 'export-shape-differs',
  CONTRADICTION: 'vendored-header-contradicts-its-code',
  TEXT: 'text-differs',
};

/**
 * One sentence naming the first line where two texts part ways.
 *
 * The catch-all. `drift` must not be empty while the files disagree, or a caller
 * that only reads the count sees a clean bill of health.
 */
function firstDifference(a, b) {
  const left = a.split('\n');
  const right = b.split('\n');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i] !== right[i]) {
      const got = left[i] === undefined ? '(local file ends)' : left[i].trim();
      const want = right[i] === undefined ? '(vendored plugin ends)' : right[i].trim();
      return `line ${i + 1} differs: local has ${JSON.stringify(got)}, vendored has ${JSON.stringify(want)}`;
    }
  }
  return 'the two texts differ only in whitespace that survived normalisation';
}

/**
 * Compare a repo's committed plugin against the one graphify would write.
 *
 * Reads only. Never writes, never repairs — see the header.
 *
 * @param {string} repoRoot
 * @param {object} [opts]
 * @param {string} [opts.vendored] vendored plugin text; a test passes a fixture.
 * @param {string} [opts.vendoredPath] read the vendored text from here instead.
 * @returns {{current: boolean, found: string|null, vendored: string,
 *            localPath: string, drift: string[], recommendation: string}}
 */
export function checkPlugin(repoRoot, opts = {}) {
  const vendored = opts.vendored ?? vendoredPlugin(opts.vendoredPath ? { sourcePath: opts.vendoredPath } : {});
  const localPath = path.join(repoRoot, PLUGIN_RELATIVE_PATH);
  const found = localPlugin(repoRoot);

  if (found === null) {
    return {
      current: false,
      found: null,
      vendored,
      localPath,
      drift: [`local plugin is absent at ${localPath}, so graphify has never written one here`],
      recommendation: 'Decide whether this project should have the graphify reminder hook before running `graphify install --project`.',
    };
  }

  const drift = [];
  const localShape = exportShape(found);
  const vendoredShape = exportShape(vendored);

  if (!PLUGIN_PACKAGE_NOTE.test(found)) {
    drift.push(
      `${DRIFT.NOTE_MISSING}: the local file no longer records why there is no import from "@opencode/plugin" — a bare .js under .opencode/plugins/ has no node_modules to resolve it from, so a plain default export is required`,
    );
  }

  if (localShape !== vendoredShape) {
    drift.push(
      `${DRIFT.SHAPE}: local exports ${localShape}, vendored 0.9.x exports ${vendoredShape} (GraphifyPlugin async factory vs { id, setup })`,
    );
  }

  if (headerContradictsCode(vendored)) {
    drift.push(
      `${DRIFT.CONTRADICTION}: the vendored header comment says the hook prepends with "&&" while its own code prepends with ";", and the same file notes PowerShell 5.1 rejects "&&"`,
    );
  }

  if (normalise(found) === normalise(vendored)) {
    return {
      current: true,
      found,
      vendored,
      localPath,
      drift: [],
      recommendation: 'Nothing to do: the local plugin is byte-identical to the one graphify would write.',
    };
  }

  drift.push(`${DRIFT.TEXT}: ${firstDifference(normalise(found), normalise(vendored))}`);

  return {
    current: false,
    found,
    vendored,
    localPath,
    drift,
    recommendation:
      'Do not let `graphify install --project` overwrite this file — the differences above are deliberate adaptations, so re-apply them after any installer run.',
  };
}
