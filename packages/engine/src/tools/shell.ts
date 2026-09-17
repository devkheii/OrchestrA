import { spawn } from "node:child_process";
import { killProcessTree } from "../runtime/kill.js";
import { redact, sanitizeChildEnv } from "../secrets/broker.js";

/**
 * Non-interactive command execution (plan 4.8; test SEC-005 integration).
 *
 * Every bound here exists because the caller is ultimately a language model:
 * the command may never terminate, may print without end, and may echo a
 * secret it was legitimately handed. None of those are hypothetical enough to
 * leave unhandled.
 *
 * The long-lived PTY (`terminal.*`) is a separate concern and lands later.
 */

export interface ExecOptions {
  cwd: string;
  /** Wall-clock ceiling. The process tree is killed when it passes. */
  timeoutMs?: number;
  /** Cancellation from the run's abort token (SPEC section 23). */
  signal?: AbortSignal;
  /** Captured output ceiling per stream. */
  maxOutputBytes?: number;
  /** Secret values to scrub from captured output before anyone reads it. */
  redactValues?: readonly string[];
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 1_000_000;

export function execCommand(
  command: string,
  args: readonly string[],
  options: ExecOptions,
): Promise<ExecResult> {
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<ExecResult>((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      // The whole point: the child gets a built environment, never the parent's.
      env: sanitizeChildEnv(process.env),
      // A group so a killed command takes its children with it, rather than
      // leaving a grandchild holding the workspace.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const capture = (stream: "out" | "err") => (chunk: Buffer) => {
      const target = stream === "out" ? stdout : stderr;
      if (target.length >= maxOutput) {
        truncated = true;
        return;
      }
      const room = maxOutput - target.length;
      const text = chunk.toString("utf8");
      const slice = text.length > room ? text.slice(0, room) : text;
      if (slice.length < text.length) truncated = true;
      if (stream === "out") stdout += slice;
      else stderr += slice;
    };

    child.stdout.on("data", capture("out"));
    child.stderr.on("data", capture("err"));

    const kill = () => {
      if (child.pid !== undefined) killProcessTree(child.pid);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      kill();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);

      const values = options.redactValues ?? [];
      resolve({
        code,
        // Redaction happens here, at the boundary, so no downstream caller has
        // to remember. Tool output goes to the model and to the audit log.
        stdout: redact(stdout, values),
        stderr: redact(stderr, values),
        timedOut,
        aborted,
        truncated,
      });
    };

    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}
