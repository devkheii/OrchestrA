import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Scoped memory (invariant 33, test SEC-017).
 *
 * Memory is the one store deliberately shared across sessions, which makes it
 * the one place a leak is silent and durable. Nothing errors when a note from
 * one project surfaces while working on another — it simply appears in a
 * prompt where it should never have been, and nobody is told.
 *
 * So scope is part of the query, never a filter applied afterwards, and a
 * query that names no owner returns nothing rather than everything. The
 * expensive default is the safe one.
 */

export type MemoryScope = "global" | "workspace" | "session" | "agent";

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  type: string;
  content: string;
  workspace?: string;
  session?: string;
  agent?: string;
  /** The decision this was learned from, so a claim can be traced back. */
  sourceDecision?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface MemoryWrite {
  scope: MemoryScope;
  type: string;
  content: string;
  workspace?: string;
  session?: string;
  agent?: string;
  sourceDecision?: string;
}

export interface MemoryQuery {
  scope: MemoryScope;
  workspace?: string;
  session?: string;
  agent?: string;
  limit?: number;
}

export interface MemoryStore {
  write(record: MemoryWrite): Promise<MemoryRecord>;
  search(query: string, scope: MemoryQuery): Promise<MemoryRecord[]>;
  delete(id: string): Promise<void>;
  close(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL,
  type            TEXT NOT NULL,
  content         TEXT NOT NULL,
  workspace       TEXT,
  session         TEXT,
  agent           TEXT,
  source_decision TEXT,
  created_at      TEXT NOT NULL,
  last_used_at    TEXT
);

CREATE INDEX IF NOT EXISTS memory_by_scope ON memory(scope, workspace, session, agent);

-- FTS5 is enough for v0.1. Embeddings and a vector store are deferred until
-- retrieval quality is demonstrably the bottleneck (SPEC section 25).
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content,
  content='memory',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
`;

/** Owner key for each scope. Global is keyed by nothing, by definition. */
type OwnerKey = "workspace" | "session" | "agent";

const OWNER_COLUMN: Record<MemoryScope, OwnerKey | null> = {
  global: null,
  workspace: "workspace",
  session: "session",
  agent: "agent",
};

interface MemoryRow {
  id: string;
  scope: string;
  type: string;
  content: string;
  workspace: string | null;
  session: string | null;
  agent: string | null;
  source_decision: string | null;
  created_at: string;
  last_used_at: string | null;
}

export function openMemoryStore(dbPath: string): Promise<MemoryStore> {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  const insert = db.prepare<
    [string, string, string, string, string | null, string | null, string | null, string | null, string]
  >(
    `INSERT INTO memory (id, scope, type, content, workspace, session, agent, source_decision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const remove = db.prepare<[string]>("DELETE FROM memory WHERE id = ?");

  const toRecord = (row: MemoryRow): MemoryRecord => {
    const record: MemoryRecord = {
      id: row.id,
      scope: row.scope as MemoryScope,
      type: row.type,
      content: row.content,
      createdAt: row.created_at,
    };
    if (row.workspace !== null) record.workspace = row.workspace;
    if (row.session !== null) record.session = row.session;
    if (row.agent !== null) record.agent = row.agent;
    if (row.source_decision !== null) record.sourceDecision = row.source_decision;
    if (row.last_used_at !== null) record.lastUsedAt = row.last_used_at;
    return record;
  };

  return Promise.resolve({
    async write(input: MemoryWrite): Promise<MemoryRecord> {
      const ownerColumn = OWNER_COLUMN[input.scope];
      if (ownerColumn !== null && !input[ownerColumn]) {
        // Refused at write time as well as read time. A record stored without
        // an owner could never be retrieved safely, and would sit in the
        // database looking like data somebody might later "fix" by relaxing
        // the read path.
        throw new Error(
          `${input.scope} memory requires a ${ownerColumn}; refusing to store an unscoped record`,
        );
      }

      const record: MemoryRecord = {
        id: `mem_${randomBytes(8).toString("hex")}`,
        scope: input.scope,
        type: input.type,
        content: input.content,
        createdAt: new Date().toISOString(),
      };
      if (input.workspace !== undefined) record.workspace = input.workspace;
      if (input.session !== undefined) record.session = input.session;
      if (input.agent !== undefined) record.agent = input.agent;
      if (input.sourceDecision !== undefined) record.sourceDecision = input.sourceDecision;

      insert.run(
        record.id,
        record.scope,
        record.type,
        record.content,
        input.workspace ?? null,
        input.session ?? null,
        input.agent ?? null,
        input.sourceDecision ?? null,
        record.createdAt,
      );
      return record;
    },

    async search(query: string, scope: MemoryQuery): Promise<MemoryRecord[]> {
      const ownerColumn = OWNER_COLUMN[scope.scope];
      const owner = ownerColumn === null ? null : scope[ownerColumn];

      // A query that names no owner returns nothing. Returning everything here
      // is the leak this invariant exists to prevent, and it would look like a
      // convenience while it did so.
      if (ownerColumn !== null && !owner) return [];

      // Scope is part of the SQL, not a filter over a wider result set: a
      // post-filter is one early `return` away from becoming a leak.
      const where =
        ownerColumn === null
          ? "m.scope = ?"
          : `m.scope = ? AND m.${ownerColumn} = ?`;
      const params = ownerColumn === null ? [scope.scope] : [scope.scope, owner as string];

      const rows = db
        .prepare(
          `SELECT m.* FROM memory_fts f
           JOIN memory m ON m.rowid = f.rowid
           WHERE ${where} AND memory_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(...params, escapeFts(query), scope.limit ?? 20) as MemoryRow[];

      return rows.map(toRecord);
    },

    async delete(id: string): Promise<void> {
      remove.run(id);
    },

    async close(): Promise<void> {
      db.close();
    },
  });
}

/**
 * FTS5 treats plenty of punctuation as syntax. User and model text is a phrase
 * to look for, not a query language, so it is quoted rather than parsed.
 */
function escapeFts(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}
