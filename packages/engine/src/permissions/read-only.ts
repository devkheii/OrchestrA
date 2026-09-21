/**
 * Which shell commands provably only read (SPEC §19.2).
 *
 * `AUTO` needs a sandbox and does not ship in v0.1 (invariant 21), so every
 * shell call is asked about. Exploring a codebase means `ls`, `cat`, `grep`,
 * `find` — one question each, and an approval asked that often stops being
 * read. An approval nobody reads is worse than none.
 *
 * What this is not: a decision that `ls` is safe and therefore automatic.
 * Nothing here grants anything. It answers whether a command *could* be
 * covered by a scope the user chooses to grant, once, for a session
 * (§19.2). The decision stays with the user; this only bounds what that
 * decision can cover.
 *
 * Strict by construction: an allowlist of verbs, and a refusal of anything
 * that could reach a second command. Allowlist over denylist is a rule this
 * project has already broken twice and paid for twice — a `<tool>` guard that
 * did not know about `<tool>`, and a CLI tool denylist missing seventeen
 * names.
 */

/**
 * Verbs that read and do nothing else.
 *
 * Deliberately short. A command nobody has thought about is a command that
 * asks, which is the correct default and the only safe one.
 */
const READ_ONLY_VERBS = new Set([
  "ls",
  "dir",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "tree",
  "file",
  "stat",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "find",
  "fd",
  "which",
  "basename",
  "dirname",
  "realpath",
  "du",
  "df",
  "echo",
]);

/**
 * `git` reads with some subcommands and writes with others, so it is the one
 * verb whose second word matters.
 */
const READ_ONLY_GIT = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "remote",
  "blame",
  "describe",
  "ls-files",
  "rev-parse",
  "shortlog",
  "tag",
]);

/**
 * Flags that turn a reading command into one that runs or writes.
 *
 * `find -exec` is still `find`, and it runs anything. So is `git --ext-diff`.
 * An allowlist of verbs without this is an allowlist with a hole in it.
 */
const ESCAPING_FLAGS = [
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprintf",
  "-fls",
  "--ext-diff",
  "--output",
  "-o=",
  "--pager",
  "-f",
  "--file",
];

/**
 * Characters that can introduce a second command, a redirect, or a
 * substitution.
 *
 * Checked on the raw string rather than after parsing: the question is whether
 * anything here could reach beyond the one verb, and the cheapest correct
 * answer is that none of these appear at all.
 */
const SHELL_OPERATORS = /[;&|<>`]|\$\(|\$\{|\n|\r/;

/** Whether this command provably only reads. Defaults to no. */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (SHELL_OPERATORS.test(trimmed)) return false;

  const words = trimmed.split(/\s+/);
  const verb = words[0];
  if (!verb) return false;

  // A path is not a verb. `/tmp/evil/ls` and `./ls` are not `ls`, and
  // accepting them would make the allowlist a list of filenames anyone can
  // choose.
  if (/[\\/]/.test(verb)) return false;

  const rest = words.slice(1);
  if (rest.some(hasEscapingFlag)) return false;

  if (verb === "git") {
    // The first word that is not a flag is the subcommand.
    const subcommand = rest.find((word) => !word.startsWith("-"));
    return Boolean(subcommand && READ_ONLY_GIT.has(subcommand));
  }

  return READ_ONLY_VERBS.has(verb);
}

function hasEscapingFlag(word: string): boolean {
  return ESCAPING_FLAGS.some((flag) =>
    flag.endsWith("=") ? word.startsWith(flag) : word === flag || word.startsWith(`${flag}=`),
  );
}
