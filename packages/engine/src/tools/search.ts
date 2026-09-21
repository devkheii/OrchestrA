import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { execCommand } from "./shell.js";

/**
 * Searching the workspace, with ripgrep when it is there (SPEC §29.1).
 *
 * §29 says to borrow mature tools rather than build them, and ripgrep is the
 * right thing to borrow. But a borrowed tool that is not installed is worse
 * than a small owned one: on a machine without it, `glob` and `grep` returned
 * the empty string on every call, and a model cannot tell that from "no
 * matches". Measured — twenty identical searches until the round budget ended
 * the turn.
 *
 * So ripgrep when present, a walker when not, and the caller is told which
 * ran. The fallback is deliberately plain: it is a floor that keeps the
 * harness usable, not a reimplementation competing with the real thing.
 */

export interface SearchOutcome {
  /** Lines of output, already formatted for a model to read. */
  text: string;
  /** Which implementation answered, so the difference is never silent. */
  via: "ripgrep" | "builtin";
}

/** Directories never worth walking, and never what anyone meant. */
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "target", ".venv"]);

const MAX_FILES = 5_000;
const MAX_MATCHES = 500;
/** Files larger than this are not searched by content: they are not source. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export async function findFiles(workspace: string, pattern: string): Promise<SearchOutcome> {
  const rg = await execCommand("rg", ["--files", "--glob", pattern], { cwd: workspace });
  if (!rg.failedToStart) {
    if (rg.code !== null && rg.code > 1) throw new Error(rg.stderr.trim() || "search failed");
    return { text: rg.stdout, via: "ripgrep" };
  }

  const matcher = globToRegExp(pattern);
  const hits: string[] = [];
  for await (const file of walk(workspace)) {
    const rel = relative(workspace, file).split(sep).join("/");
    if (matcher.test(rel) || matcher.test(rel.split("/").pop() ?? "")) hits.push(rel);
    if (hits.length >= MAX_FILES) break;
  }
  return { text: hits.join("\n"), via: "builtin" };
}

export async function findInFiles(
  workspace: string,
  pattern: string,
  target: string,
  redactValues?: readonly string[],
): Promise<SearchOutcome> {
  const rg = await execCommand("rg", ["--line-number", pattern, target], {
    cwd: workspace,
    ...(redactValues ? { redactValues } : {}),
  });
  if (!rg.failedToStart) {
    // ripgrep exits 1 for "no matches", which is an answer, not a failure.
    if (rg.code !== null && rg.code > 1) throw new Error(rg.stderr.trim() || "search failed");
    return { text: rg.stdout, via: "ripgrep" };
  }

  let expression: RegExp;
  try {
    expression = new RegExp(pattern);
  } catch (err) {
    throw new Error(`not a valid pattern: ${(err as Error).message}`);
  }

  const lines: string[] = [];
  for await (const file of walk(target)) {
    if (lines.length >= MAX_MATCHES) break;
    let text: string;
    try {
      const info = await stat(file);
      if (info.size > MAX_FILE_BYTES) continue;
      text = await readFile(file, "utf8");
    } catch {
      continue; // Unreadable or vanished. Not a result and not an error.
    }

    const rel = relative(workspace, file).split(sep).join("/") || file;
    text.split("\n").forEach((line, i) => {
      if (lines.length < MAX_MATCHES && expression.test(line)) {
        lines.push(`${rel}:${i + 1}:${line}`);
      }
    });
  }
  return { text: lines.join("\n"), via: "builtin" };
}

async function* walk(root: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return; // Not a directory, or not readable.
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".dem") continue;
    if (SKIP.has(entry.name)) continue;

    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

/**
 * A glob, as a regular expression.
 *
 * Supports what people actually type: `*`, `**`, `?` and a leading directory.
 * Anything more elaborate is a reason to install ripgrep, and the caller says
 * which implementation answered so that is visible.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp(`^${escaped}$`);
}
