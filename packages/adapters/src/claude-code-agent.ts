import { spawn } from "node:child_process";
import type { AgentRun, AgentResult, ExternalAgent } from "@dem/engine";

/**
 * Claude Code as an external agent (SPEC §4.2, invariant 34).
 *
 * This is what the CLI actually is, and running it here rather than as a
 * provider is the difference between using a tool and fighting it.
 *
 * As a provider it had to have all 31 of its tools stripped, because a tool it
 * ran would execute under its permission model instead of ours. Here it keeps
 * them: it is working inside an isolated copy of the workspace, so its edits
 * land somewhere the harness is willing to throw away, and whatever it
 * produces comes back as a proposal the harness applies through its own patch
 * path. The boundary does the work the stripping was standing in for.
 *
 * What is given up is real and is stated rather than glossed: for the duration
 * of the run there is no permission broker, no path guard and no conflict
 * detection over what the agent does inside the copy. The delegation record
 * says so.
 */

export interface ClaudeCodeAgentConfig {
  /** Alias (`opus`, `sonnet`) or full model id. */
  model?: string;
  command?: string;
  /** Args before the CLI flags, e.g. a script path when command is node. */
  commandArgs?: readonly string[];
  /** Wall-clock ceiling for one delegated run. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export class ClaudeCodeAgent implements ExternalAgent {
  readonly id: string;

  constructor(private readonly config: ClaudeCodeAgentConfig = {}) {
    this.id = `claude-code:${config.model ?? "default"}`;
  }

  /**
   * Always false, for the same reason the provider form is.
   *
   * The binary is local; the task and every file it reads go to Anthropic.
   * Delegation is egress, and the gate follows the data.
   */
  isLocal(): boolean {
    return false;
  }

  async run(run: AgentRun): Promise<AgentResult> {
    const args = [
      ...(this.config.commandArgs ?? []),
      "-p",
      "--output-format",
      "json",
      ...(this.config.model ? ["--model", this.config.model] : []),
      // Its own tools are wanted here — that is the point of delegating — and
      // they are confined to the copy it was handed.
      "--permission-mode",
      "acceptEdits",
      "--add-dir",
      run.workdir,
    ];

    return new Promise<AgentResult>((resolve) => {
      const child = spawn(this.command(), args, {
        cwd: run.workdir,
        ...(this.config.env ? { env: this.config.env } : {}),
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, this.config.timeoutMs ?? 600_000);

      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, log: `could not start: ${err.message}` });
      });

      child.on("close", (code) => {
        clearTimeout(timer);

        if (timedOut) {
          resolve({ ok: false, log: `timed out after ${this.config.timeoutMs ?? 600_000}ms` });
          return;
        }

        // The agent's own transcript, kept whole and opaque. Parsing it into
        // our event types would present its tool calls as though they had
        // passed our broker, and not one of them did.
        const log = stdout || stderr;
        resolve({ ok: code === 0, log });
      });

      // stdin, not argv: a command line is readable by any process that can
      // list processes, and the task is the user's content.
      child.stdin.write(run.task);
      child.stdin.end();
    });
  }

  private command(): string {
    if (this.config.command) return this.config.command;
    return process.platform === "win32" ? "claude.exe" : "claude";
  }
}
