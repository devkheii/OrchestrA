import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { makeId } from "@dem/protocol";
import type { SessionEvent, SessionEventInput, SessionId } from "@dem/protocol";
import type { SessionRecord, SessionStore } from "./store.js";

/**
 * SQLite-backed session store (test RUN-004).
 *
 * The event log *is* the state, not a cache of it. A session that evaporates
 * when the daemon restarts would make the audit trail a story about a process
 * rather than about the work, and `dem attach` would have nothing to attach to.
 *
 * Events are append-only: no UPDATE or DELETE statement exists in this file.
 * That is what invariant 16 rests on — compaction adds artifacts beside this
 * table and never edits it.
 */

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  workspace   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  status      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  seq         INTEGER NOT NULL,
  type        TEXT NOT NULL,
  at          TEXT NOT NULL,
  payload     TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX IF NOT EXISTS events_by_session ON events(session_id, seq);
`;

interface SessionRow {
  id: string;
  workspace: string;
  created_at: string;
  status: string;
}

interface EventRow {
  seq: number;
  payload: string;
}

export function openSessionStore(dbPath: string): Promise<SessionStore> {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  // WAL lets a reader (a second CLI, the Web UI) attach while a run is writing.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  const version = (db.pragma("user_version", { simple: true }) as number) || 0;
  if (version === 0) db.pragma(`user_version = ${SCHEMA_VERSION}`);
  else if (version > SCHEMA_VERSION) {
    throw new Error(
      `session store at ${dbPath} was written by a newer schema (v${version} > v${SCHEMA_VERSION}); refusing to open`,
    );
  }

  const insertSession = db.prepare<[string, string, string, string]>(
    "INSERT INTO sessions (id, workspace, created_at, status) VALUES (?, ?, ?, ?)",
  );
  const selectSession = db.prepare<[string]>("SELECT * FROM sessions WHERE id = ?");
  const nextSeq = db.prepare<[string]>(
    "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE session_id = ?",
  );
  const insertEvent = db.prepare<[string, number, string, string, string]>(
    "INSERT INTO events (session_id, seq, type, at, payload) VALUES (?, ?, ?, ?, ?)",
  );
  const selectEvents = db.prepare<[string, number]>(
    "SELECT seq, payload FROM events WHERE session_id = ? AND seq > ? ORDER BY seq",
  );

  const toRecord = (row: SessionRow): SessionRecord => ({
    id: row.id as SessionId,
    workspace: row.workspace,
    createdAt: row.created_at,
    status: row.status as SessionRecord["status"],
  });

  /**
   * Sequence assignment and insert share one transaction, so two concurrent
   * appends cannot read the same maximum and collide. The primary key would
   * catch a collision anyway; the transaction means it never happens.
   */
  const appendTx = db.transaction((id: string, event: SessionEventInput): SessionEvent => {
    const { seq } = nextSeq.get(id) as { seq: number };
    insertEvent.run(id, seq, event.type, event.at, JSON.stringify(event));
    return { ...event, seq } as SessionEvent;
  });

  const store: SessionStore = {
    async create(workspace: string): Promise<SessionRecord> {
      const record: SessionRecord = {
        id: makeId("session", () => randomBytes(8).toString("hex")),
        workspace,
        createdAt: new Date().toISOString(),
        status: "active",
      };
      insertSession.run(record.id, record.workspace, record.createdAt, record.status);
      return record;
    },

    async get(id: SessionId): Promise<SessionRecord | null> {
      const row = selectSession.get(id) as SessionRow | undefined;
      return row ? toRecord(row) : null;
    },

    async append(id: SessionId, event: SessionEventInput): Promise<SessionEvent> {
      if (!selectSession.get(id)) throw new Error(`unknown session: ${id}`);
      return appendTx(id, event);
    },

    async events(id: SessionId, sinceSeq = 0): Promise<SessionEvent[]> {
      const rows = selectEvents.all(id, sinceSeq) as EventRow[];
      return rows.map((row) => ({ ...JSON.parse(row.payload), seq: row.seq }) as SessionEvent);
    },

    async close(): Promise<void> {
      db.close();
    },
  };

  return Promise.resolve(store);
}
