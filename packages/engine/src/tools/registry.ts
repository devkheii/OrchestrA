import { readFile } from "node:fs/promises";
import type { PermissionDecision, PermissionMode, SandboxHealth, TaintState, ToolAction } from "@dem/protocol";
import { decide, segmentCommand } from "../permissions/broker.js";
import { resolveWorkspacePath } from "../policy/path-guard.js";
import { applyPatch, hashFile } from "./patch.js";
import { execCommand } from "./shell.js";

/**
 * The tool surface, and the single way in (invariant 36, test SEC-020).
 *
 * There is no `execute(call)` here. The only entry point is `runToolCall`,
 * which decides before it dispatches. That shape is the point: a check the
 * caller is supposed to perform gets skipped eventually — by an internal caller
 * that "already knows" the call is safe, by a retry path reusing an earlier
 * decision, by a tool added later that reaches for its implementation directly.
 * Making the decision the only route means none of those exist to be taken.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** What the broker judges this as. Every tool must name one. */
  action: ToolAction;
  /** JSON Schema for the model-facing definition. */
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

export interface ToolContext {
  workspace: string;
  redactValues?: readonly string[];
}

export interface ToolRegistry {
  list(): readonly ToolSpec[];
  get(name: string): ToolSpec | undefined;
  context: ToolContext;
}

export interface CallPolicy {
  mode: PermissionMode;
  taint: TaintState;
  sandbox: SandboxHealth;
  /** Set once the user has approved this specific call. */
  approved?: boolean;
}

export interface ToolCallResult {
  /** Always present: every call is decided, including denied ones. */
  decision: PermissionDecision;
  executed: boolean;
  /** True when the broker said `ask` and no approval accompanied the call. */
  needsApproval?: boolean;
  output?: unknown;
  error?: string;
}

const str = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
};

export function createToolRegistry(context: ToolContext): ToolRegistry {
  const specs: ToolSpec[] = [
    {
      name: "read",
      description: "Read a file from the workspace.",
      action: "read",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the workspace root." },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const { realPath } = await resolveWorkspacePath(ctx.workspace, str(args, "path"));
        const text = await readFile(realPath, "utf8");
        const lines = text.split("\n");
        const offset = typeof args["offset"] === "number" ? args["offset"] : 0;
        const limit = typeof args["limit"] === "number" ? args["limit"] : 2000;
        return lines.slice(offset, offset + limit).join("\n");
      },
    },
    {
      name: "grep",
      description: "Search file contents in the workspace.",
      action: "search",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const target = typeof args["path"] === "string" ? args["path"] : ".";
        const { realPath } = await resolveWorkspacePath(ctx.workspace, target);
        // ripgrep rather than our own walker (SPEC section 29).
        const result = await execCommand("rg", ["--line-number", str(args, "pattern"), realPath], {
          cwd: ctx.workspace,
          ...(ctx.redactValues ? { redactValues: ctx.redactValues } : {}),
        });
        // rg exits 1 for "no matches", which is an answer, not a failure.
        return result.code === 0 || result.code === 1 ? result.stdout : result.stderr;
      },
    },
    {
      name: "glob",
      description: "List workspace files matching a pattern.",
      action: "search",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const result = await execCommand("rg", ["--files", "--glob", str(args, "pattern")], {
          cwd: ctx.workspace,
        });
        return result.stdout;
      },
    },
    {
      name: "patch",
      description: "Create, update or delete a workspace file. Updates need the current hash.",
      action: "patch",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          expectedHash: {
            type: "string",
            description: "Hash the file had when read. Omit to create a new file.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const path = str(args, "path");
        const expected = args["expectedHash"];

        if (typeof expected === "string" && expected) {
          return applyPatch(ctx.workspace, [
            { kind: "update", path, expectedHash: expected, content: str(args, "content") },
          ]);
        }
        return applyPatch(ctx.workspace, [
          { kind: "create", path, content: str(args, "content") },
        ]);
      },
    },
    {
      name: "hash",
      description: "Hash of a workspace file, for use as patch expectedHash.",
      action: "read",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const { realPath } = await resolveWorkspacePath(ctx.workspace, str(args, "path"));
        return hashFile(realPath);
      },
    },
    {
      name: "shell",
      description: "Run a non-interactive command in the workspace.",
      action: "shell",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeoutMs: { type: "number" },
        },
        required: ["command"],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const command = str(args, "command");
        const result = await execCommand(shellBinary(), [shellFlag(), command], {
          cwd: ctx.workspace,
          ...(typeof args["timeoutMs"] === "number" ? { timeoutMs: args["timeoutMs"] } : {}),
          ...(ctx.redactValues ? { redactValues: ctx.redactValues } : {}),
        });
        return { code: result.code, stdout: result.stdout, stderr: result.stderr };
      },
    },
  ];

  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  return {
    list: () => specs,
    get: (name) => byName.get(name),
    context,
  };
}

/**
 * The only way to run a tool.
 *
 * A shell command is segmented first, and the strictest segment decides the
 * whole call: `echo safe && rm -rf /` is one approval in the user's eyes and
 * two commands in the shell's, and the user approved what they read.
 */
export async function runToolCall(
  registry: ToolRegistry,
  call: { id: string; name: string; arguments: Record<string, unknown> },
  policy: CallPolicy,
): Promise<ToolCallResult> {
  const spec = registry.get(call.name);

  if (!spec) {
    return {
      decision: { outcome: "deny", rule: `unknown tool: ${call.name}` },
      executed: false,
      error: `unknown tool: ${call.name}`,
    };
  }

  const decision = decideForCall(spec, call.arguments, policy);

  if (decision.outcome === "deny") {
    return { decision, executed: false, error: `denied: ${decision.rule}` };
  }
  if (decision.outcome === "ask" && !policy.approved) {
    return { decision, executed: false, needsApproval: true };
  }

  try {
    return { decision, executed: true, output: await spec.run(call.arguments, registry.context) };
  } catch (err) {
    // A failed tool is a result the model should see and react to, not an
    // exception that unwinds the session.
    return { decision, executed: false, error: (err as Error).message };
  }
}

function decideForCall(
  spec: ToolSpec,
  args: Record<string, unknown>,
  policy: CallPolicy,
): PermissionDecision {
  const subject = typeof args["command"] === "string" ? args["command"] : String(args["path"] ?? "");

  const base = decide({ action: spec.action, subject, ...policy });
  if (spec.action !== "shell") return base;

  const segments = segmentCommand(subject);
  const destructive = segments.filter(isDestructive);

  // A destructive command hidden inside a chain is refused outright rather
  // than merely asked about.
  //
  // The difference is what the user actually read. Approving `rm -rf build` is
  // a decision about `rm -rf build`. Approving `npm test && rm -rf /` is a
  // decision the user believes they made about `npm test` — the eye stops at
  // the first clause, and the approval prompt is where that costs something.
  // Alone, a destructive command is visible and can be asked about; chained,
  // it has to be split out and asked about on its own.
  if (destructive.length > 0 && segments.length > 1) {
    return {
      outcome: "deny",
      rule: `destructive segment in a compound command: ${destructive[0]}`,
      invariant: 36,
    };
  }

  // Otherwise the strictest segment decides the whole call.
  let worst = base;
  for (const segment of segments) {
    const action: ToolAction = isDestructive(segment) ? "destructive" : "shell";
    const segmentDecision = decide({ action, subject: segment, ...policy });
    if (rank(segmentDecision.outcome) > rank(worst.outcome)) worst = segmentDecision;
  }
  return worst;
}

const rank = (outcome: PermissionDecision["outcome"]): number =>
  ({ auto: 0, ask: 1, deny: 2 })[outcome];

/**
 * Commands that are refused rather than merely asked about. Matched on the
 * segment, so chaining cannot hide one behind a harmless prefix.
 */
const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\b(shutdown|reboot)\b/i,
  /:\(\)\s*\{.*\};:/,
];

function isDestructive(segment: string): boolean {
  return DESTRUCTIVE.some((re) => re.test(segment));
}

function shellBinary(): string {
  return process.platform === "win32" ? "cmd.exe" : "/bin/sh";
}

function shellFlag(): string {
  return process.platform === "win32" ? "/c" : "-c";
}
