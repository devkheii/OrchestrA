/**
 * What the session is doing, as data.
 *
 * Kept apart from the rendering so it can be tested without a terminal. A TUI
 * whose logic lives inside components is one whose behaviour can only be
 * checked by looking at it, and the approval path in particular is the last
 * thing in this harness that should be verified by eye.
 */

export type Role = "user" | "assistant" | "system" | "tool";

export interface Line {
  id: number;
  role: Role;
  text: string;
  /** Set while the assistant is still streaming into this line. */
  streaming?: boolean;
}

export interface PendingApproval {
  tool: string;
  subject: string;
  rule: string;
  /**
   * Whether this command provably only reads (SPEC 19.2).
   *
   * Offers a scope the user may grant once for the session, instead of being
   * asked six times to explore one directory. Nothing is granted by being
   * read-only; it only bounds what the user's own choice can cover.
   */
  readOnly?: boolean;
}

export interface SelectOption {
  label: string;
  value: string;
  detail?: string;
  /** Marked in the list, e.g. the model already in use. */
  current?: boolean;
}

export interface SelectRequest {
  title: string;
  options: SelectOption[];
}

export interface AskRequest {
  question: string;
  /** Input is not echoed — a credential, typically. */
  secret?: boolean;
}

/** Exactly one of these is what the session wants from the user right now. */
export type Prompt =
  | { kind: "input" }
  | { kind: "approval"; pending: PendingApproval }
  | { kind: "select"; request: SelectRequest }
  | { kind: "ask"; request: AskRequest }
  | { kind: "busy"; note: string };

export interface SessionState {
  lines: Line[];
  prompt: Prompt;
  /** Shown in the header: workspace, provider, whether context leaves here. */
  header: { workspace: string; label: string; local: boolean; mode: string };
  sessionId: string;
  /** Set when the session should exit. */
  done?: boolean;
}

let nextId = 1;

export function line(role: Role, text: string, streaming = false): Line {
  return { id: nextId++, role, text, ...(streaming ? { streaming: true } : {}) };
}

/**
 * Append text to the line being streamed, or start one.
 *
 * Deltas arrive many per second and each one re-renders. Mutating the last
 * line rather than pushing a new one is what keeps a long answer from becoming
 * a thousand-element list that the terminal redraws from scratch.
 */
export function appendDelta(lines: readonly Line[], text: string): Line[] {
  const last = lines.at(-1);
  if (last?.role === "assistant" && last.streaming) {
    return [...lines.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...lines, line("assistant", text, true)];
}

/** Mark the streaming line finished, so nothing renders a cursor on it. */
export function settle(lines: readonly Line[]): Line[] {
  const last = lines.at(-1);
  if (!last?.streaming) return [...lines];
  return [...lines.slice(0, -1), { ...last, streaming: false }];
}

/**
 * Keep the transcript bounded.
 *
 * A session that runs for an hour should not hold every token it ever
 * rendered. The tail is what a person is reading; the whole conversation is in
 * the event log, which is the record either way (`dem log`).
 */
export function trim(lines: readonly Line[], max = 500): Line[] {
  return lines.length <= max ? [...lines] : lines.slice(lines.length - max);
}

/** What a select prompt returns when the user presses escape rather than choosing. */
export const CANCELLED = Symbol("cancelled");
