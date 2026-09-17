import { randomBytes } from "node:crypto";
import * as pty from "node-pty";
import { redact, sanitizeChildEnv } from "../secrets/broker.js";

/**
 * Long-lived terminal (SPEC section 17, plan 4.8).
 *
 * A PTY is the loosest surface the harness exposes: it outlives a single tool
 * call, holds a live shell, and feeds its output back to a model. Every
 * property established for one-shot `shell.exec` has to be established again
 * here — a sanitiser applied at one spawn site protects nothing at the other.
 *
 * We do not implement a terminal emulator. node-pty owns the platform detail
 * (ConPTY on Windows, forkpty elsewhere); this module owns policy: what the
 * child inherits, how much is kept, and what the model is allowed to see.
 */

export interface TerminalOptions {
  command: string;
  args?: readonly string[];
  cwd: string;
  cols?: number;
  rows?: number;
  /** Ceiling on retained output. Oldest bytes are dropped first. */
  maxScrollbackBytes?: number;
  /** Secret values scrubbed from the snapshot before anyone reads it. */
  redactValues?: readonly string[];
}

export interface TerminalSession {
  readonly id: string;
  readonly pid: number;
  write(data: string): void;
  /** Subscribe to output. Returns an unsubscribe function. */
  onData(listener: (chunk: string) => void): () => void;
  /** Retained output, bounded and redacted. Safe to put in a prompt. */
  snapshot(): string;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** Resolves with the exit code. */
  readonly exited: Promise<number>;
}

export interface TerminalManager {
  start(options: TerminalOptions): TerminalSession;
  get(id: string): TerminalSession | undefined;
  stop(id: string): void;
  stopAll(): void;
  ids(): string[];
}

const DEFAULT_SCROLLBACK = 200_000;

export function createTerminalManager(): TerminalManager {
  const sessions = new Map<string, TerminalSession>();

  const manager: TerminalManager = {
    start(options: TerminalOptions): TerminalSession {
      const id = `pty_${randomBytes(6).toString("hex")}`;
      const maxScrollback = options.maxScrollbackBytes ?? DEFAULT_SCROLLBACK;
      const redactValues = options.redactValues ?? [];

      const child = pty.spawn(options.command, [...(options.args ?? [])], {
        name: "xterm-color",
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        cwd: options.cwd,
        // Same allowlist as shell.exec. A PTY is not a reason to relax it.
        env: sanitizeChildEnv(process.env) as Record<string, string>,
      });

      let scrollback = "";
      const listeners = new Set<(chunk: string) => void>();

      let resolveExit: (code: number) => void;
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });

      child.onData((chunk) => {
        // Redacted on arrival, not on read. Doing it on read means the raw
        // value sits in memory until someone remembers to call the right
        // accessor, and one that forgets leaks it.
        const clean = redact(chunk, redactValues);
        scrollback += clean;
        if (scrollback.length > maxScrollback) {
          // Keep the tail. Dropping the newest output would show a model the
          // start of a build and never the error that ended it.
          scrollback = scrollback.slice(scrollback.length - maxScrollback);
        }
        for (const listener of listeners) listener(clean);
      });

      child.onExit(({ exitCode }) => {
        sessions.delete(id);
        resolveExit(exitCode);
      });

      const session: TerminalSession = {
        id,
        pid: child.pid,
        write: (data) => child.write(data),
        onData(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        snapshot: () => scrollback,
        resize: (cols, rows) => child.resize(cols, rows),
        kill() {
          try {
            child.kill();
          } catch {
            // Already gone; onExit has run or is about to.
          }
          sessions.delete(id);
        },
        exited,
      };

      sessions.set(id, session);
      return session;
    },

    get: (id) => sessions.get(id),

    stop(id) {
      sessions.get(id)?.kill();
      sessions.delete(id);
    },

    stopAll() {
      for (const session of [...sessions.values()]) session.kill();
      sessions.clear();
    },

    ids: () => [...sessions.keys()],
  };

  return manager;
}
