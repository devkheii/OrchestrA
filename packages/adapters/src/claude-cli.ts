import { spawn } from "node:child_process";
import { CAP_TEXT_GENERATE, CAP_TEXT_REASON } from "@dem/protocol";
import type {
  ModelEvent,
  ModelRequest,
  Provider,
  ProviderHealth,
  RunContext,
} from "@dem/protocol";

/**
 * The Claude Code CLI as a text provider.
 *
 * Useful because it needs no API key of its own — it reuses whatever the user
 * already authenticated with — which makes it the easiest real model to point
 * this harness at.
 *
 * Three constraints shape the implementation, and each of them is an invariant
 * rather than a preference:
 *
 * 1. **This is not local.** The process runs on this machine; the context goes
 *    to Anthropic. Classifying by where the process runs instead of where the
 *    data goes would make `isLocal()` — and with it the whole egress policy —
 *    quietly meaningless. See `isLocal()`.
 *
 * 2. **The CLI's own tools are disabled.** It ships Bash, Edit, Write and the
 *    rest. If they ran, file writes and commands would happen inside the CLI's
 *    permission model rather than ours, which is exactly what invariant 7
 *    forbids. We use it as a text generator, not as an agent we hand work to.
 *
 * 3. **The prompt goes over stdin, never argv.** Command lines are visible to
 *    any process that can list processes, so an argv prompt leaks whatever the
 *    user asked about to every other program on the machine.
 *
 * **On cost.** Running under a Claude subscription, a call is not billed per
 * request: it draws on the account's rate-limit window, and when that window is
 * exhausted requests are refused rather than charged. The `total_cost_usd` the
 * CLI reports is an equivalent-API-cost figure, not money spent. So when this
 * is wired to the budget ceilings in SPEC section 24, it must be recorded as a
 * quota proxy — treating it as spend would either block a user who is not being
 * charged, or quietly imply a bill that does not exist. The real scarce resource
 * here is the same five-hour window the user needs for their own work.
 */

export interface ClaudeCliConfig {
  /** Alias (`opus`, `sonnet`) or full model id. */
  model?: string;
  /** Executable path. Overridable so tests can run a stand-in. */
  command?: string;
  /** Args placed before the CLI flags, e.g. a script path when command is node. */
  commandArgs?: readonly string[];
  timeoutMs?: number;
  /** Environment for the child. Defaults to the caller's sanitized env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Every tool the CLI is known to ship. All of them are refused, because ours is
 * the permission broker (invariant 7).
 *
 * `--allowedTools` cannot express this: it grants auto-approval without
 * removing anything, so an "allow nothing" run still advertises Bash, Edit and
 * PowerShell to the model. `--disallowedTools` is the only flag that removes a
 * tool, which makes this a denylist — the pattern criticised two files over for
 * environment variables, and for the same reason: it fails open for every tool
 * nobody thought of. An earlier version of this list missed PowerShell,
 * CronCreate and EnterWorktree, which is precisely the failure mode.
 *
 * So the list is paired with a runtime check in `run()` that refuses to
 * proceed if the CLI still advertises anything. The denylist does the work; the
 * check is what makes it fail closed when a future release adds a tool.
 */
const DISABLED_TOOLS = [
  "AskUserQuestion",
  "Bash",
  "BashOutput",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "KillShell",
  "Monitor",
  "NotebookEdit",
  "PowerShell",
  "PushNotification",
  "Read",
  "RemoteTrigger",
  "ScheduleWakeup",
  "Skill",
  "SlashCommand",
  "Task",
  "TaskOutput",
  "TaskStop",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Write",
];

export class ClaudeCliProvider implements Provider {
  readonly id: string;

  constructor(private readonly config: ClaudeCliConfig = {}) {
    this.id = `claude-cli:${config.model ?? "default"}`;
  }

  capabilities(): readonly string[] {
    // No tool.call: this provider generates text. Tool use belongs to the
    // harness, under the harness's permission broker.
    return [CAP_TEXT_GENERATE, CAP_TEXT_REASON];
  }

  /**
   * Always false.
   *
   * The binary is on this machine, so it is tempting to call this local. It is
   * not: every prompt it receives is sent to Anthropic. Egress policy has to
   * follow the data, not the executable — a provider that lied here would let
   * a whole workspace leave the machine while the UI said LOCAL.
   */
  isLocal(): boolean {
    return false;
  }

  async health(): Promise<ProviderHealth> {
    try {
      const { code, stdout } = await this.runOnce(
        [...(this.config.commandArgs ?? []), "--version"],
        "",
        10_000,
      );
      return code === 0
        ? { ok: true, detail: `claude cli ${stdout.trim()}` }
        : { ok: false, detail: `claude --version exited ${code}` };
    } catch (err) {
      return { ok: false, detail: `not runnable: ${(err as Error).message}` };
    }
  }

  async *run(request: ModelRequest, context?: RunContext): AsyncIterable<ModelEvent> {
    const prompt = request.messages.map((m) => m.content).join("\n\n");
    const args = [
      ...(this.config.commandArgs ?? []),
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      ...(this.config.model ? ["--model", this.config.model] : []),
      "--disallowedTools",
      ...DISABLED_TOOLS,
    ];

    const child = spawn(this.command(), args, {
      ...(this.config.env ? { env: this.config.env } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const onAbort = () => child.kill();
    context?.signal?.addEventListener("abort", onAbort, { once: true });

    // stdin, not argv: a command line is readable by any process that can list
    // processes, and the prompt is the user's content.
    child.stdin.write(prompt);
    child.stdin.end();

    const frames = readLines(child);
    let reason: "stop" | "length" | "cancelled" = "stop";
    let sawText = false;

    try {
      for await (const line of frames) {
        if (context?.signal?.aborted) break;

        let frame: CliFrame;
        try {
          frame = JSON.parse(line) as CliFrame;
        } catch {
          continue;
        }

        // The CLI reports its tool surface before generating anything. If our
        // denylist did not cover everything — a new release, a renamed tool —
        // the model is holding capabilities that never pass our permission
        // broker, so the run is refused rather than allowed to proceed.
        // Failing closed here is the difference between a stale list being a
        // maintenance task and being a hole.
        if (frame.type === "system" && frame.subtype === "init") {
          const advertised = frame.tools ?? [];
          if (advertised.length > 0) {
            yield {
              type: "error",
              message:
                `claude cli still advertises ${advertised.length} tool(s) after the disallow list: ` +
                `${advertised.join(", ")}. Refusing to run: these would bypass the permission broker. ` +
                `Add them to DISABLED_TOOLS.`,
            };
            return;
          }
        }

        // Token-level deltas. `thinking_delta` is deliberately not handled:
        // reasoning is dropped at the boundary, where it can still be told
        // apart from the answer (invariant 17).
        if (frame.type === "stream_event" && frame.event?.type === "content_block_delta") {
          const delta = frame.event.delta;
          if (delta?.type === "text_delta" && delta.text) {
            sawText = true;
            yield { type: "delta", text: delta.text };
          }
        }

        if (frame.type === "result") {
          if (frame.is_error) {
            yield { type: "error", message: frame.result ?? "claude cli reported an error" };
            return;
          }
          if (frame.stop_reason === "max_tokens") reason = "length";
          // Some runs report only the final result with no partial deltas.
          // Emitting it here means a caller never silently receives nothing.
          if (!sawText && frame.result) yield { type: "delta", text: frame.result };
        }
      }
    } finally {
      context?.signal?.removeEventListener("abort", onAbort);
      child.kill();
    }

    yield { type: "done", reason: context?.signal?.aborted ? "cancelled" : reason };
  }

  private command(): string {
    if (this.config.command) return this.config.command;
    return process.platform === "win32" ? "claude.exe" : "claude";
  }

  private runOnce(args: string[], input: string, timeoutMs: number) {
    return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(this.command(), args, {
        ...(this.config.env ? { env: this.config.env } : {}),
      });
      let stdout = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("timed out"));
      }, timeoutMs);

      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout });
      });
      child.stdin.write(input);
      child.stdin.end();
    });
  }
}

interface CliFrame {
  type: string;
  subtype?: string;
  tools?: string[];
  is_error?: boolean;
  result?: string;
  stop_reason?: string;
  total_cost_usd?: number;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
}

/** Split the child's stdout into newline-delimited JSON frames. */
async function* readLines(child: {
  stdout: NodeJS.ReadableStream;
}): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of child.stdout) {
    buffer += (chunk as Buffer).toString("utf8");
    let boundary = buffer.indexOf("\n");
    while (boundary !== -1) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (line) yield line;
      boundary = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) yield buffer.trim();
}
