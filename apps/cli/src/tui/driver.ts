import type { DaemonHandle } from "@dem/protocol";
import type { Settings } from "@dem/engine";
import { createSession, runTurn, type Approver, type Io } from "../session-ui.js";
import { runSessionCommand, type CommandOption } from "../session-commands.js";
import { discoverServers, discoverWeights, humanSize, labelForModels } from "@dem/engine";
import { appendDelta, line, settle, trim, type Prompt, type SessionState } from "./state.js";

/**
 * Driving the session, with the view told what changed.
 *
 * Everything here was already written and tested against the line-based
 * session: `runTurn` streams a turn, `runSessionCommand` edits configuration,
 * and approval is a function the caller supplies. This adapts those to a
 * render loop, which is the whole reason replacing the interface did not mean
 * rewriting the parts that decide anything.
 *
 * One question is outstanding at a time. A terminal that asks two things at
 * once has two readers on one stdin, which looks to a user like keystrokes
 * being swallowed.
 */

/** A menu entry that means "changed my mind", distinct from any real value. */
const CANCEL = "\u0000cancel";

/**
 * The listing endpoint, for both ways a baseUrl gets written.
 *
 * The same trap the adapter fell into: a configured URL usually already ends
 * in /v1, and appending another asks for /v1/v1/models.
 */
function modelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
}

export interface Driver {
  state: SessionState;
  subscribe(listener: (state: SessionState) => void): () => void;
  submit(text: string): void;
  answer(text: string): void;
  cancel(): void;
}

export async function createDriver(options: {
  daemon: DaemonHandle;
  settings: Settings;
  workspace: string;
  local: boolean;
  label: string;
}): Promise<Driver> {
  const { daemon, settings, workspace, local, label } = options;

  let state: SessionState = {
    lines: [],
    prompt: { kind: "input" },
    header: { workspace, label, local, mode: settings.security.maxMode },
    sessionId: await createSession(daemon, workspace),
  };

  const listeners = new Set<(s: SessionState) => void>();
  const emit = (next: Partial<SessionState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener(state);
  };

  const say = (role: "system" | "user" | "tool", text: string) =>
    emit({ lines: trim([...state.lines, line(role, text)]) });

  /** The answer to whatever is being asked, resolved when the user replies. */
  let pendingAnswer: ((value: string) => void) | undefined;

  const askThrough = (prompt: Prompt): Promise<string> =>
    new Promise((resolve) => {
      pendingAnswer = (value) => {
        pendingAnswer = undefined;
        emit({ prompt: { kind: "busy", note: "working" } });
        resolve(value);
      };
      emit({ prompt });
    });

  /**
   * Streamed output, turned into state.
   *
   * `runTurn` writes through an `Io`, so this is where a write becomes a
   * render rather than a line on a terminal that Ink is also drawing to —
   * two writers on one screen is how a TUI ends up with torn output.
   */
  const io: Io = {
    out: (text) => emit({ lines: trim(appendDelta(state.lines, text)) }),
    err: (text) => {
      const trimmed = text.trim();
      if (trimmed) say("system", trimmed);
    },
  };

  // Approvals granted for the rest of this session, keyed per tool and per
  // subject: yes to `npm test` is not yes to `rm -rf build` (SPEC §19).
  const allowed = new Set<string>();

  const approve: Approver = async (pending) => {
    const subject =
      typeof pending.call.arguments["command"] === "string"
        ? pending.call.arguments["command"]
        : JSON.stringify(pending.call.arguments);
    const key = `${pending.call.name}:${subject}`;

    if (allowed.has(key)) {
      say("tool", `${pending.call.name} ${subject}  (allowed earlier)`);
      return true;
    }

    const answer = await askThrough({
      kind: "approval",
      pending: { tool: pending.call.name, subject, rule: pending.rule },
    });

    if (answer === "a") {
      allowed.add(key);
      return true;
    }
    return answer === "y";
  };

  let seq = 0;
  let running = false;

  async function submit(text: string): Promise<void> {
    const input = text.trim();
    if (!input || running) return;

    if (input.startsWith("/")) {
      // Echoed like anything else the user typed. A command that produces
      // output with no visible cause reads as the session acting on its own.
      say("user", input);
      await command(input);
      return;
    }

    say("user", input);
    running = true;
    emit({ prompt: { kind: "busy", note: "thinking" } });

    try {
      const result = await runTurn(daemon, state.sessionId, input, io, approve, seq);
      seq = result.seq;
      emit({ lines: settle(state.lines) });
    } catch (err) {
      say("system", (err as Error).message);
    } finally {
      running = false;
      emit({ prompt: { kind: "input" } });
    }
  }

  async function command(input: string): Promise<void> {
    if (input === "/session") {
      say("system", state.sessionId);
      return;
    }
    if (input === "/new") {
      const sessionId = await createSession(daemon, workspace);
      seq = 0;
      emit({ sessionId, lines: [line("system", `new session ${sessionId}`)] });
      return;
    }

    const result = await runSessionCommand(input, {
      workspace,
      io,
      ask: (question) =>
        askThrough({
          kind: "ask",
          // A prompt that says "key" is a prompt whose answer should not be
          // on screen afterwards.
          request: { question, secret: /key/i.test(question) },
        }),

      // Arrow keys rather than typing a name back. The whole point of a
      // renderer is that a list is something you move through.
      select: async (title, options) => {
        const chosen = await askThrough({
          kind: "select",
          request: { title, options: [...options, { label: "cancel", value: CANCEL }] },
        });
        return chosen === CANCEL ? undefined : chosen;
      },

      // What the endpoint currently serves. Without this `/model` could only
      // print the name already configured, which is not a list of anything.
      listModels: async () => {
        const res = await fetch(modelsUrl(settings.baseUrl ?? ""));
        if (!res.ok) throw new Error(`endpoint returned ${res.status}`);
        const body = (await res.json()) as { data?: Array<{ id?: string }> };
        return (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
      },

      // And what else is on this machine, so adding a provider starts from
      // what is running rather than from a blank field.
      discover: async (): Promise<CommandOption[]> => {
        const [servers, weights] = await Promise.all([discoverServers(), discoverWeights()]);
        return [
          ...servers.map((server) => ({
            label: server.kind,
            value: `${server.baseUrl}/v1`,
            detail: `${server.baseUrl}  ${labelForModels(server.models)}`,
          })),
          ...weights.slice(0, 6).map((found) => ({
            label: found.path.split(/[\/]/).pop() ?? found.path,
            value: "http://127.0.0.1:8099",
            detail: `${humanSize(found.sizeBytes)}  served locally`,
          })),
        ];
      },
    });

    if (result.exit) {
      emit({ done: true });
      return;
    }
    if (result.changed) {
      say("system", "written — restart dem for it to take effect");
    }
    emit({ prompt: { kind: "input" } });
  }

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submit(text) {
      void submit(text);
    },
    answer(text) {
      // Only meaningful while something is waiting; a stray escape otherwise.
      pendingAnswer?.(text);
    },
    cancel() {
      // Declines whatever is being asked rather than ending the session. A
      // key that quits is a key pressed by accident.
      pendingAnswer?.("n");
    },
  };
}
