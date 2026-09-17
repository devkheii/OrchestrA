import { cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { applyPatch, hashContent, hashFile, type PatchOp } from "../tools/patch.js";
import { resolveWorkspacePath } from "../policy/path-guard.js";

/**
 * Delegation to an external agent (invariant 34, test SEC-018; SPEC §4.2).
 *
 * An external agent brings its own loop, its own tools and its own permission
 * model, so for as long as it runs every invariant in §2 is suspended. That is
 * worth having for large autonomous coding work, and it is only worth having
 * with a boundary around it.
 *
 * The boundary exists to survive one specific temptation: letting the agent
 * work in the real tree, because it is simpler and the diff is right there.
 * That single convenience would suspend the path guard, the conflict detection
 * and the permission broker at once, for the whole run. So the agent gets a
 * copy, and whatever it produces comes back as a proposal the harness applies
 * itself.
 */

export interface AgentRun {
  /** An isolated copy. Never the live workspace. */
  workdir: string;
  task: string;
}

export interface AgentResult {
  ok: boolean;
  /** The agent's own log, kept opaque. */
  log: string;
}

export interface ExternalAgent {
  readonly id: string;
  /** Delegation is egress: these agents relay the task to a third party. */
  isLocal(): boolean;
  run(run: AgentRun): Promise<AgentResult>;
}

export interface DelegateOptions {
  workspace: string;
  task: string;
  /** Applying the agent's changes is a separate decision from running it. */
  approved: boolean;
  /** Directories never copied into the sandbox copy. */
  exclude?: readonly string[];
}

export interface ProposedChange {
  kind: "create" | "update";
  path: string;
  content: string;
  /** Hash the live file had when the copy was taken. */
  baseHash: string;
}

export interface DelegationOutcome {
  ok: boolean;
  agentId: string;
  /** Always true. Stated rather than implied, so a reader is not left to infer it. */
  guaranteesSuspended: true;
  changes: ProposedChange[];
  applied: boolean;
  /** Paths whose live content moved while the agent worked. */
  conflicts: string[];
  agentLog: string;
}

/**
 * Copying these would make delegation unusable on a real project, and a `.git`
 * copy would let an agent rewrite history inside the clone where nobody looks.
 */
const DEFAULT_EXCLUDE = ["node_modules", ".git", "dist", "build", ".next", "coverage", ".venv"];

export async function delegate(
  agent: ExternalAgent,
  options: DelegateOptions,
): Promise<DelegationOutcome> {
  const exclude = new Set(options.exclude ?? DEFAULT_EXCLUDE);
  const workdir = await mkdtemp(join(tmpdir(), "dem-delegate-"));

  try {
    // Snapshot before the agent starts, so a change made to the live tree
    // while it works is detectable rather than silently overwritten.
    const before = await snapshot(options.workspace, exclude);
    await copyInto(options.workspace, workdir, exclude);

    const result = await agent.run({ workdir, task: options.task });

    const changes = await diffAgainst(before, workdir);

    if (!result.ok) {
      // An agent that failed has not produced a considered change set. An
      // empty diff from a crash is not the same as an agent deciding nothing
      // needed doing, and applying either would be guessing which it was.
      return outcome(agent, false, changes, false, [], result.log);
    }

    if (!options.approved) {
      return outcome(agent, true, changes, false, [], result.log);
    }

    const applied = await applyDelegated(options.workspace, changes);
    return outcome(agent, true, changes, applied.applied, applied.conflicts, result.log);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

/**
 * Apply a change set the agent already produced.
 *
 * Separate from `delegate` because running the agent and accepting its work
 * are separate decisions, and a caller that wants to show the diff before
 * asking must not have to run the agent twice to do it — that would cost a
 * second run and, worse, produce a different diff from the one the user was
 * shown.
 */
export async function applyDelegated(
  workspace: string,
  changes: readonly ProposedChange[],
): Promise<{ applied: boolean; conflicts: string[] }> {
  const conflicts = await findConflicts(workspace, changes);
  if (conflicts.length > 0) return { applied: false, conflicts };

  // Re-applied by us, through the same patch path as any other edit: path
  // guard, expected-hash conflict detection, and an auditable op per file.
  await applyPatch(workspace, changes.map(toPatchOp));
  return { applied: true, conflicts: [] };
}

function outcome(
  agent: ExternalAgent,
  ok: boolean,
  changes: ProposedChange[],
  applied: boolean,
  conflicts: string[],
  agentLog: string,
): DelegationOutcome {
  return { ok, agentId: agent.id, guaranteesSuspended: true, changes, applied, conflicts, agentLog };
}

function toPatchOp(change: ProposedChange): PatchOp {
  return change.kind === "create"
    ? { kind: "create", path: change.path, content: change.content }
    : { kind: "update", path: change.path, expectedHash: change.baseHash, content: change.content };
}

/** Relative path -> content hash, for every file the agent will see. */
async function snapshot(
  root: string,
  exclude: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for await (const file of walk(root, exclude)) {
    out.set(relative(root, file).split(sep).join("/"), await hashFile(file));
  }
  return out;
}

async function copyInto(from: string, to: string, exclude: ReadonlySet<string>): Promise<void> {
  await cp(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src);
      if (!rel) return true;
      return !rel.split(sep).some((segment) => exclude.has(segment));
    },
  });
}

/** What the agent changed, expressed against the pre-run snapshot. */
async function diffAgainst(
  before: ReadonlyMap<string, string>,
  workdir: string,
): Promise<ProposedChange[]> {
  const changes: ProposedChange[] = [];

  for await (const file of walk(workdir, new Set())) {
    const rel = relative(workdir, file).split(sep).join("/");
    const content = await readFile(file, "utf8");
    const baseHash = before.get(rel);

    if (baseHash === undefined) {
      changes.push({ kind: "create", path: rel, content, baseHash: "" });
    } else if (hashContent(content) !== baseHash) {
      changes.push({ kind: "update", path: rel, content, baseHash });
    }
  }

  // Deletions are deliberately not carried across. An agent removing a file it
  // merely failed to write is indistinguishable here from one that meant it,
  // and re-applying the wrong guess destroys work. Deletion needs its own
  // explicit signal from the agent, which none of them give yet.
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** Files whose live content moved while the agent was working. */
async function findConflicts(
  workspace: string,
  changes: readonly ProposedChange[],
): Promise<string[]> {
  const conflicts: string[] = [];

  for (const change of changes) {
    if (change.kind === "create") continue;
    const { realPath } = await resolveWorkspacePath(workspace, change.path);
    if ((await hashFile(realPath)) !== change.baseHash) conflicts.push(change.path);
  }
  return conflicts;
}

async function* walk(dir: string, exclude: ReadonlySet<string>): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (exclude.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full, exclude);
    } else if (entry.isFile()) {
      // Skip anything that is not a regular readable file: a socket or a
      // device node in a workspace is not content to diff.
      const info = await stat(full).catch(() => null);
      if (info?.isFile()) yield full;
    }
  }
}
