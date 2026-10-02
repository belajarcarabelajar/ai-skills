#!/usr/bin/env node
// scripts/lib/test-fixture-db.mjs — a small synthetic OpenCode database.
//
// WHY A FIXTURE EXISTS AT ALL
//
// The real database is 454 MB with 1020 sessions, 54948 messages, 13.2 MiB of
// INLINE BASE64 attachments stored inside user-message JSON, and a `credential`
// table with two real secrets. None of that belongs in a unit test: it is slow,
// machine-dependent, and touching the `credential` table at all is off limits.
// Every test in `opencode-db.test.mjs` reads one of these fixtures instead.
//
// WHAT MAKES THE FIXTURE HONEST
//
// A fixture that is easier than the real thing tests nothing. So the DDL below
// is the real DDL, column for column, and the `data` JSON blobs carry the
// real per-type key sets:
//
//   user       time, text, files, agents
//   assistant  time, agent, model, content, snapshot, finish, error, cost,
//              tokens, retry, rawFinish, providerState
//   idle       time, outcome
//   synthetic  time, text, description, metadata
//
// and the assistant parts use the real `$.content[]` shapes — `text`,
// `reasoning`, `tool` — including `state.metadata.outputPath`, the pointer a
// renderer follows when a tool's output was spilled to disk. User `files[]`
// entries carry INLINE BASE64 beginning with the PNG magic `iVBORw0KGgo`, not
// a filesystem path; a fixture that stored paths would let an
// attachment-rendering bug pass.
//
// The deliberate awkwardness, all three of which exist in the real data:
//
//   * one session has `title = NULL` (36 of the 1009 real sessions do)
//   * every session has `path = ''` (all 1009 real rows do)
//   * `journal_mode = WAL`, so a copy-based reader can be shown to disagree
//     with a by-path reader
//
// DETERMINISM IS A REQUIREMENT, NOT A NICETY
//
// No `Date.now()`, no `Math.random()`, no ambient state. Ids and timestamps are
// injected or default to constants, so two builds produce byte-identical
// `listSessions()` output. A drifting fixture would quietly weaken every
// ordering assertion in the test file that depends on it.
//
// Rows are inserted in DESCENDING seq order, too. See the loop below for why a
// fixture that inserts in seq order would test nothing.

import { Database } from 'bun:sqlite';
import path from 'node:path';

/** Base ms-epoch timestamp. Fixed; overridable per build. */
export const FIXTURE_EPOCH_MS = 1_756_000_000_000; // 2025-08-21T00:53:20Z

export const FIXTURE_PROJECT_ID = 'prj_fixture';
export const FIXTURE_PROJECT_WORKTREE = '/fixture/project-a';
export const FIXTURE_VERSION = '0.1.0';

/** Default session ids, in seeded (and therefore expected) order. */
export const FIXTURE_SESSION_IDS = Object.freeze([
  'ses_fixture_titled',
  'ses_fixture_untitled',
  'ses_fixture_attachments',
]);

// A real 1x1 PNG. Deterministic, and its base64 carries the PNG magic that a
// real inline attachment starts with.
export const FIXTURE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Verbatim from the real database, including the `project` table that
// session_v2's foreign key points at and the unique (session_id, seq) index.
// Faithful shape, empty content.
const DDL = [
  `CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        , \`time_active\` integer DEFAULT 0 NOT NULL)`,
  `CREATE TABLE \`session_v2\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`fork_session_id\` text,
          \`fork_boundary\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_idle\` integer,
          \`time_viewed\` integer,
          \`idle_outcome\` text,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          \`time_suspended\` integer,
          \`resume_attempts\` integer DEFAULT 0 NOT NULL,
          CONSTRAINT \`fk_session_v2_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        )`,
  `CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        )`,
  'CREATE UNIQUE INDEX `session_message_session_seq_idx` ON `session_message` (`session_id`,`seq`)',
];

const INSERT_SESSION = `INSERT INTO session_v2
  (id, project_id, slug, directory, path, title, version, cost, tokens_input,
   tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
   agent, model, time_created, time_updated)
VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 'build', 'fixture-model-1', ?, ?)`;

const INSERT_MESSAGE = `INSERT INTO session_message
  (id, session_id, type, seq, time_created, time_updated, data)
VALUES (?, ?, ?, ?, ?, ?, ?)`;

// ---------- message payloads ----------

const j = (v) => JSON.stringify(v);

function userData(epoch, text, files = []) {
  // Real key set: time, text, files, agents.
  return { time: { created: epoch }, text, files, agents: [] };
}

function assistantData(epoch, { text, reasoning, tool, truncated = false }) {
  // Real key set, all twelve, including the ones that are null for a clean turn.
  return {
    time: { created: epoch, streamed: epoch + 120, completed: epoch + 300 },
    agent: 'build',
    model: { id: 'fixture-model-1', providerID: 'fixture', variant: 'default' },
    content: [
      reasoning && {
        type: 'reasoning',
        text: reasoning,
        state: { reasoningField: 'reasoning_content' },
        time: { created: epoch + 40, completed: epoch + 100 },
      },
      text && {
        type: 'text',
        text,
        state: { time: { start: epoch + 300, end: epoch + 300 } },
      },
      tool && {
        type: 'tool',
        id: 'call_fixture_0001',
        name: 'read',
        executed: true,
        state: {
          status: 'completed',
          input: { path: '/fixture/project-a/notes.md' },
          content: [{ type: 'text', text: truncated ? '' : 'Read 1 file' }],
          metadata: {
            truncated,
            // The pointer a renderer follows when output was spilled to disk.
            outputPath: '/fixture/project-a/.opencode/tool-output/call_fixture_0001',
            outputLength: truncated ? 1048576 : 11,
          },
        },
        time: { created: epoch + 200, ran: epoch + 250 },
        providerState: { done: true },
      },
    ].filter(Boolean),
    snapshot: null,
    finish: 'stop',
    error: null,
    cost: 0,
    tokens: { input: 1200, output: 340, reasoning: 90, cache: { read: 900, write: 0 } },
    retry: null,
    rawFinish: 'stop',
    providerState: {},
  };
}

function idleData(epoch, outcome = 'succeeded') {
  // Real key set: time, outcome.
  return { time: { created: epoch }, outcome };
}

function syntheticData(epoch) {
  // Real key set: time, text, description, metadata.
  const command = 'bun test scripts/lib/';
  return {
    time: { created: epoch },
    text: `<shell id="sh_fixture0001" state="completed" command="${command}">\n3 pass\n</shell>`,
    description: command,
    metadata: {
      source: 'shell',
      shellID: 'sh_fixture0001',
      jobID: 'sh_fixture0001',
      state: 'completed',
      truncated: false,
      exit: 0,
    },
  };
}

const attachment = () => ({
  // INLINE base64, not a path. The real entries start with PNG magic.
  data: FIXTURE_PNG_BASE64,
  mime: 'image/png',
  source: { type: 'inline' },
  name: 'fixture-screenshot.png',
  mention: { start: 0, end: 9, text: '[Image 1]' },
});

// ---------- the seed ----------

// Index 1 is the untitled session, because that is the row shape the reader
// most often gets wrong.
const TITLES = ['Fixture: a session that was named', null, 'Fixture: a session with attachments'];

/**
 * Build a small OpenCode-shaped database at `destPath`.
 *
 * @param {string} destPath where to write the SQLite file
 * @param {{ epochMs?: number, sessionIds?: string[] }} [opts] injected ids and
 *   base timestamp; both default to module constants so two default builds are
 *   identical
 * @returns {{ path: string, sessionIds: string[], epochMs: number }}
 */
export function buildFixtureDb(destPath, opts = {}) {
  if (typeof destPath !== 'string' || destPath === '') {
    throw new TypeError(`buildFixtureDb: destPath must be a non-empty string, got ${typeof destPath}`);
  }
  const epochMs = opts.epochMs ?? FIXTURE_EPOCH_MS;
  const sessionIds = opts.sessionIds ?? [...FIXTURE_SESSION_IDS];

  const db = new Database(destPath, { create: true });
  try {
    // WAL, so the -wal-is-part-of-the-database behaviour is exercised rather
    // than assumed. Asserted back through PRAGMA journal_mode by the test.
    db.exec('PRAGMA journal_mode = WAL');
    for (const ddl of DDL) db.exec(ddl);

    db.run(
      `INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes)
       VALUES (?, ?, 'git', 'fixture', ?, ?, '{}')`,
      [FIXTURE_PROJECT_ID, FIXTURE_PROJECT_WORKTREE, epochMs, epochMs],
    );

    sessionIds.forEach((sessionId, i) => {
      const created = epochMs + i * 1000;
      db.run(INSERT_SESSION, [
        sessionId,
        FIXTURE_PROJECT_ID,
        `fixture-slug-${i}`,
        FIXTURE_PROJECT_WORKTREE,
        // Every real row has path = ''; keeping it that way stops a fixture
        // from implying a path-based fallback that does not exist.
        '',
        TITLES[i] ?? null,
        FIXTURE_VERSION,
        created,
        created + 5000,
      ]);

      // seq is 0-based and unique per session, matching the real
      // (session_id, seq) unique index.
      const messages = [
        {
          type: 'user',
          data: userData(
            created + 10,
            i === 2 ? 'Look at this screenshot and tell me what it shows.' : 'Summarise the fixture project.',
            i === 2 ? [attachment()] : [],
          ),
        },
        {
          type: 'assistant',
          data: assistantData(created + 20, {
            text: i === 2 ? 'The screenshot shows a fixture row.' : 'Here is what the fixture project contains.',
            reasoning: 'The user asked about the fixture. Read the directory first, then answer.',
            tool: {
              text: i === 1 ? '' : 'Read 1 file',
              truncated: i === 1,
            },
          }),
        },
        { type: 'idle', data: idleData(created + 30, 'succeeded') },
        { type: 'synthetic', data: syntheticData(created + 40) },
      ];

      // Inserted in DESCENDING seq order on purpose. SQLite is free to return
      // rows in rowid order when there is no ORDER BY, so a fixture inserted
      // in seq order would let a reader with a missing `ORDER BY seq` pass by
      // luck. Writing the rows backwards makes the ORDER BY load-bearing.
      for (let n = messages.length - 1; n >= 0; n--) {
        const seq = n;
        const m = messages[seq];
        db.run(INSERT_MESSAGE, [
          `msg_${sessionId}_${seq}`,
          sessionId,
          m.type,
          seq,
          created + 10 + seq * 10,
          created + 10 + seq * 10,
          j(m.data),
        ]);
      }
    });
  } finally {
    // Closing the last connection checkpoints and removes -wal/-shm, which is
    // what lets the copy-vs-by-path test start from a clean main file.
    db.close();
  }

  return { path: path.resolve(destPath), sessionIds, epochMs };
}