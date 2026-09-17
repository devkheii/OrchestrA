import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

    const launch = await this.resolveLaunch();

    return new Promise<AgentResult>((resolve) => {
      const child = spawn(launch.command, [...launch.prefix, ...args], {
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
        const verdict = readVerdict(stdout);

        if (verdict.fatal) {
          resolve({ ok: false, log: `${verdict.fatal}\n\n${log}` });
          return;
        }

        // Success is confirmed, not assumed. Codex exits zero on failure — a
        // rejected model produces retries, an error event, a failed turn, and
        // still `exit 0`. Asking for a completed turn is positive evidence;
        // "no error was seen" is only the absence of one, and would call a run
        // successful whenever a failure arrived in a shape not yet known.
        if (verdict.sawTurn && !verdict.completed) {
          resolve({ ok: false, log: `codex did not complete its turn\n\n${log}` });
          return;
        }

        resolve({ ok: code === 0, log });
      });

      child.stdin.write(run.task);
      child.stdin.end();
    });
  }

  /**
   * How to start Codex.
   *
   * npm installs it as `bin/codex.js` plus platform shims. On Windows the shim
   * is a `.cmd`, which Node refuses to spawn without `shell: true` — and a
   * shell would then reparse our arguments, at which point a workspace path
   * containing a space, or a `-c key="value"` override, breaks in ways that
   * are tedious to see. Running the JS entry point under node avoids the shell
   * entirely, so the argument vector we build is the one Codex receives.
   *
   * Resolved once and cached; the fallback is the bare name, which is correct
   * wherever a real executable is on PATH.
   */
  private async resolveLaunch(): Promise<{ command: string; prefix: string[] }> {
    if (this.config.command) return { command: this.config.command, prefix: [] };
    if (this.launch) return this.launch;

    const entry = await findGlobalEntry();
    this.launch = entry
      ? { command: process.execPath, prefix: [entry] }
      : { command: "codex", prefix: [] };

    return this.launch;
  }

  private launch?: { command: string; prefix: string[] };
}

/** `@openai/codex/bin/codex.js` in the global npm root, if it is there. */
async function findGlobalEntry(): Promise<string | null> {
  const root = await new Promise<string | null>((resolve) => {
    const npm = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32",
    });
    let out = "";
    npm.stdout.on("data", (d: Buffer) => (out += d.toString()));
    npm.on("error", () => resolve(null));
    npm.on("close", (code) => resolve(code === 0 ? out.trim() : null));
  });

  if (!root) return null;

  const entry = join(root, "@openai", "codex", "bin", "codex.js");
  return existsSync(entry) ? entry : null;
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

interface Verdict {
  fatal: string | null;
  sawTurn: boolean;
  completed: boolean;
}

interface CodexFrame {
  type?: string;
  message?: string;
  error?: { message?: string };
  item?: { type?: string; message?: string };
  /** Pre-0.154 wrapped everything in `msg`. */
  msg?: { type?: string; message?: string };
}

/**
 * Read a verdict out of the JSONL stream.
 *
 * Two event vocabularies are handled because the CLI changed one under us.
 * Up to 0.40 every frame was wrapped in `msg`; from 0.154 the type is
 * top-level and turns are bracketed by `turn.started` / `turn.completed`.
 * Supporting both costs a few lines and means a user on either version gets
 * correct failure reporting rather than silent success.
 *
 * The distinction that matters most is which errors are fatal. An
 * `item.completed` carrying `type: "error"` may be a warning — "model metadata
 * not found, defaulting to fallback" arrives exactly that way on a run that
 * then succeeds. Treating it as fatal would fail working runs. Only a
 * top-level `error`, a `turn.failed`, or the old wrapped `error` end a run.
 */
function readVerdict(stdout: string): Verdict {
  const verdict: Verdict = { fatal: null, sawTurn: false, completed: false };

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;

    let frame: CodexFrame;
    try {
      frame = JSON.parse(line) as CodexFrame;
    } catch {
      // Not JSONL — human-readable output. Left alone.
      continue;
    }

    // 0.154+
    if (frame.type === "turn.started") verdict.sawTurn = true;
    if (frame.type === "turn.completed") verdict.completed = true;
    if (frame.type === "turn.failed") {
      verdict.fatal = frame.error?.message ?? "codex turn failed";
    }
    if (frame.type === "error") {
      verdict.fatal = frame.message ?? "codex reported an error";
    }

    // <= 0.40. `stream_error` there is a retry in progress, not a verdict.
    if (frame.msg?.type === "error") {
      verdict.fatal = frame.msg.message ?? "codex reported an error";
    }
  }

  return verdict;
}
