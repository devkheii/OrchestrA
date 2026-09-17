import { spawn } from "node:child_process";
import type { AgentRun, AgentResult, ExternalAgent } from "@dem/engine";

/**
 * Codex CLI as an external agent (SPEC §4.2, invariant 34).
 *
 * Alongside Claude Code this gives the harness two agents from different
 * vendors, which matters later: a council of models that share a failure mode
 * agrees confidently and wrongly, and two independent stacks are the cheapest
 * defence against that.
 *
 * Codex brings something Claude Code does not — its own OS sandbox
 * (`--sandbox workspace-write`), which confines model-generated shell commands
 * to the working root. Combined with our isolated copy that is two independent
 * boundaries rather than one, so neither has to be perfect.
 *
 * **The user's own config is deliberately not inherited.** `~/.codex/config.toml`
 * carries MCP servers — on the machine this was written for, a browser
 * controller, AWS documentation lookups and more. Loading them into a delegated
 * run would hand the agent reach far outside the copy we isolated it in, which
 * is the one thing the isolation exists to prevent. The sandbox mode and
 * approval policy are pinned here for the same reason: a delegated run should
 * not change behaviour because someone edited a personal config file.
 */

export interface CodexAgentConfig {
  model?: string;
  command?: string;
  commandArgs?: readonly string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Inherit `~/.codex/config.toml`, including its MCP servers. Off by design;
   * a caller that turns it on is widening the boundary knowingly.
   */
  inheritUserConfig?: boolean;
}

export class CodexAgent implements ExternalAgent {
  readonly id: string;

  constructor(private readonly config: CodexAgentConfig = {}) {
    this.id = `codex:${config.model ?? "default"}`;
  }

  /**
   * Always false. The binary is local; the task and every file it reads go to
   * OpenAI. Delegation is egress, and the gate follows the data.
   */
  isLocal(): boolean {
    return false;
  }

  async run(run: AgentRun): Promise<AgentResult> {
    const args = [
      ...(this.config.commandArgs ?? []),
      "exec",
      "--json",
      // Codex's own sandbox, confining generated commands to the working root.
      // Never `--dangerously-bypass-approvals-and-sandbox`: the copy is a
      // boundary, not a licence to remove the other one.
      "--sandbox",
      "workspace-write",
      // The copy excludes .git, so a repo check would fail on every run.
      "--skip-git-repo-check",
      "-C",
      run.workdir,
      ...(this.config.model ? ["-m", this.config.model] : []),
      ...(this.config.inheritUserConfig ? [] : ISOLATION_OVERRIDES),
      // `-` reads the prompt from stdin rather than argv, so the task does not
      // appear in the process table for every other program to read.
      "-",
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

        const log = stdout || stderr;

        // Codex reports some failures as an `error` event while still exiting
        // zero — a model the installed CLI is too old for does exactly that.
        // Trusting the exit code alone would turn a run that did nothing into
        // a successful one with an empty diff.
        const failed = fatalError(stdout);
        if (failed) {
          resolve({ ok: false, log: `${failed}\n\n${log}` });
          return;
        }

        resolve({ ok: code === 0, log });
      });

      child.stdin.write(run.task);
      child.stdin.end();
    });
  }

  private command(): string {
    return this.config.command ?? "codex";
  }
}

/**
 * Overrides applied to every delegated run.
 *
 * `-c` takes a dotted path and a JSON value. Emptying `mcp_servers` is the
 * important one: it is the only part of a personal config that can give the
 * agent a network reach the sandbox does not cover.
 */
const ISOLATION_OVERRIDES = [
  "-c",
  "mcp_servers={}",
  "-c",
  'approval_policy="never"',
];

/** The last fatal `error` event in a JSONL stream, if any. */
function fatalError(stdout: string): string | null {
  let found: string | null = null;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const frame = JSON.parse(line) as { msg?: { type?: string; message?: string } };
      // `stream_error` is a retry in progress, not a verdict; only the plain
      // `error` event means the run gave up.
      if (frame.msg?.type === "error") found = frame.msg.message ?? "codex reported an error";
    } catch {
      // Not JSONL — human-readable output from an older CLI. Left alone.
    }
  }
  return found;
}
