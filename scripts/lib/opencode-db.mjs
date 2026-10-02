#!/usr/bin/env node
// scripts/lib/opencode-db.mjs — read-only reader for the OpenCode session DB.
//
// WHY THIS OPENS BY PATH AND NEVER COPIES
//
// The real database lives at `~/.local/share/opencode/opencode.db` and runs in
// WAL mode (`PRAGMA journal_mode` = `wal`, measured 2026-10-02, with a
// multi-megabyte live `-wal`). sqlite.org/wal.html is explicit about what that
// means for anything that treats the main file as a portable snapshot:
//
//   "The -wal file is part of the persistent state of the database and should
//    be kept with the database if the database is copied or moved. If a
//    database file is separated from its WAL file, then transactions that were
//    previously committed to the database might be lost."
//
// So the reader takes a path and opens the path. There is no copy step and no
// `--snapshot`-style escape hatch, because both silently answer a different
// question than the one being asked.
//
// HOW READ-ONLY IS ENFORCED (and a measured caveat)
//
// The intent is the URI `file:<path>?mode=ro`, and `buildReadonlyUri()` below
// produces exactly that string, exported so a test can assert the form without
// needing a database to open.
//
// The caveat, measured on bun 1.4.2 rather than assumed: `bun:sqlite` does NOT
// parse SQLite URI filenames. Every one of these fails with SQLITE_CANTOPEN on
// a path that opens fine otherwise, because bun passes the `file:...` string
// straight through as a filename:
//
//     new Database(`file:${P}?mode=ro`)
//     new Database(`file:${P}?mode=ro`, { readonly: true })
//     new Database(`file:${P}?mode=ro`, { readonly: true, create: false })
//
// So the enforcement here is `readonly: true` (SQLITE_OPEN_READONLY), which
// SQLite itself implements and which produces SQLITE_READONLY on INSERT,
// UPDATE, DELETE, CREATE TABLE and even a `PRAGMA user_version` write. That is
// enforced by the engine, not by this module declining to write — which is the
// distinction `opencode-db.test.mjs` section 5 exists to make. `create: false`
// is the other half: without it a mistyped filename opens as a brand new empty
// database, which reports zero sessions and reads exactly like a real answer.
//
// WHAT IS DELIBERATELY NOT HERE
//
// No query in this file touches the `credential` table, which holds real
// secrets. Not a SELECT, not a count, not a schema listing. There is no
// `listTables()`-style escape hatch here for the same reason: an API that can
// enumerate the database should not also be the one holding the reader's
// privilege.
//
// MESSAGE `data` IS RETURNED AS A STRING. Every one of the 54501 rows measured
// on the real database was valid JSON, but parsing is the renderer's job and
// this layer's job is to hand back rows without interpreting them.

import { Database } from 'bun:sqlite';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_OPENCODE_DB_PATH = path.join(
  os.homedir(),
  '.local',
  'share',
  'opencode',
  'opencode.db',
);

export const SESSION_TABLE = 'session_v2';
export const MESSAGE_TABLE = 'session_message';

// Both orderings carry a tiebreaker on purpose. `time_created` is not unique
// and `seq` is unique only WITHIN a session, so a single-column ORDER BY would
// make the reader's output depend on SQLite's choice of scan path. A renderer
// that diffs two runs would then see spurious reordering.
export const SESSION_ORDER_BY = 'time_created ASC, id ASC';
export const MESSAGE_ORDER_BY = 'seq ASC';

// The SQLite URI query string that encodes "open for reading only".
export const READONLY_URI_QUERY = 'mode=ro';

// The options actually handed to bun:sqlite, frozen so no caller can mutate a
// shared object into something weaker.
export const OPEN_READONLY_OPTIONS = Object.freeze({ readonly: true, create: false });

// Characters SQLite reserves inside a URI pathname. A path containing one of
// these would otherwise produce an ambiguous `file:` string whose meaning
// depends on how many `?` and `#` it has.
const URI_PATH_ESCAPES = { '?': '%3F', '#': '%23' };

/**
 * Build the canonical read-only SQLite URI for a database path.
 * Pure string work — nothing is opened, so it is safe to call on paths that do
 * not exist, which is exactly what a missing-path test wants to assert against.
 */
export function buildReadonlyUri(dbPath, query = READONLY_URI_QUERY) {
  if (typeof dbPath !== 'string' || dbPath === '') {
    throw new TypeError(`buildReadonlyUri: dbPath must be a non-empty string, got ${typeof dbPath}`);
  }
  const encoded = dbPath.replace(/[?#]/g, (c) => URI_PATH_ESCAPES[c]);
  return `file:${encoded}${query === '' ? '' : `?${query}`}`;
}

/**
 * Open an OpenCode database for reading only.
 *
 * Opens by PATH. Does not copy, does not checkpoint, does not migrate.
 *
 * @param {string} dbPath filesystem path to the SQLite file
 * @returns {{ db: import('bun:sqlite').Database, path: string, uri: string,
 *            options: Readonly<{readonly: true, create: false}>, close: () => void }}
 */
export function openReadonly(dbPath) {
  if (typeof dbPath !== 'string' || dbPath === '') {
    throw new TypeError(`openReadonly: dbPath must be a non-empty string, got ${typeof dbPath}`);
  }
  // create:false means a path that does not exist throws SQLITE_CANTOPEN
  // instead of materialising an empty database. That distinction is the whole
  // reason "0 sessions" is a safe answer to believe.
  const db = new Database(dbPath, OPEN_READONLY_OPTIONS);
  let closed = false;
  return {
    db,
    path: dbPath,
    // Reported rather than used; see the bun:sqlite caveat in the header.
    uri: buildReadonlyUri(dbPath),
    options: OPEN_READONLY_OPTIONS,
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

const rowsOf = (db, sql, params = []) => db.query(sql).all(...params);

/**
 * All sessions, oldest first.
 *
 * `title` is passed through untouched, including SQL NULL. 36 of the 1009 real
 * sessions have `title IS NULL` — an unnamed session is an ordinary row, and
 * substituting '' would erase the difference between "never named" and "named
 * blank". Deciding how to display it belongs to the renderer.
 */
export function listSessions(db) {
  return rowsOf(
    db,
    `SELECT id, title, directory, path, slug, project_id, version,
            time_created, time_updated, cost, agent, model
       FROM ${SESSION_TABLE}
      ORDER BY ${SESSION_ORDER_BY}`,
  ).map((r) => ({
    id: r.id,
    title: r.title ?? null,
    directory: r.directory,
    path: r.path ?? null,
    slug: r.slug,
    projectId: r.project_id,
    version: r.version,
    timeCreated: r.time_created,
    timeUpdated: r.time_updated,
    cost: r.cost,
    agent: r.agent ?? null,
    model: r.model ?? null,
  }));
}

/**
 * Messages for one session, in `seq` order (the real unique index
 * `session_message_session_seq_idx` is on `(session_id, seq)`).
 *
 * `data` is returned as the raw JSON TEXT, not parsed. Parsing 54k JSON
 * documents to render one session is how a reader turns a 30 ms query into a
 * multi-second stall.
 */
export function messagesForSession(db, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new TypeError(`messagesForSession: sessionId must be a non-empty string, got ${typeof sessionId}`);
  }
  return rowsOf(
    db,
    `SELECT id, session_id, type, seq, time_created, time_updated, data
       FROM ${MESSAGE_TABLE}
      WHERE session_id = ?
      ORDER BY ${MESSAGE_ORDER_BY}`,
    [sessionId],
  ).map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    type: r.type,
    seq: r.seq,
    timeCreated: r.time_created,
    timeUpdated: r.time_updated,
    data: r.data,
  }));
}

/** Row count of session_v2, straight from the engine rather than by counting an array. */
export function countSessions(db) {
  return db.query(`SELECT count(*) AS n FROM ${SESSION_TABLE}`).get().n;
}