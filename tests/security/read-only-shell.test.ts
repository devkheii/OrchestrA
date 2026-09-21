import { describe, expect, it } from "vitest";
import { isReadOnlyCommand } from "@dem/engine";

/**
 * Classifying a shell command as read-only, so a session can be asked once
 * instead of six times (SPEC §19.2).
 *
 * `AUTO` needs a sandbox and does not ship in v0.1 (invariant 21), so every
 * shell call is asked about. Exploring a codebase means `ls`, `cat`, `grep`,
 * `find` — a question each, and an approval asked that often stops being read.
 *
 * The answer is not to decide unilaterally that `ls` is safe. It is to let the
 * user grant one scope, once, over commands that provably only read. This is
 * the test of "provably".
 *
 * Strict by construction: an allowlist of verbs, and a refusal of anything
 * that could run a second command. A denylist here would be the same mistake
 * this project has already made twice.
 */

describe("Commands that only read", () => {
  it("accepts the ones an agent explores with", () => {
    for (const command of [
      "ls",
      "ls -la packages/engine/src",
      "cat README.md",
      "head -20 package.json",
      "tail -n 5 log.txt",
      "wc -l src/index.ts",
      "pwd",
      "grep -rn TODO src",
      "rg --files",
      "find . -name '*.ts'",
      "git status",
      "git log --oneline -5",
      "git diff",
      "tree -L 2",
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(true);
    }
  });
});

describe("Commands that are not", () => {
  it("refuses anything that writes, deletes or installs", () => {
    for (const command of [
      "rm -rf build",
      "npm install",
      "git push",
      "git commit -m x",
      "mv a b",
      "cp a b",
      "chmod +x run.sh",
      "curl https://example.com",
      "node script.js",
      "pnpm run build",
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
  });

  it("refuses a read-only verb that can run something else", () => {
    // The reason this is an allowlist of verbs *and* a refusal of operators:
    // `find -exec` is `find`, and it runs anything.
    for (const command of [
      "find . -name '*.ts' -exec rm {} ;",
      "find . -delete",
      "git log --ext-diff",
      "grep -r x . --include=*.ts -f /dev/stdin",
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
  });

  it("refuses anything with a second command in it", () => {
    for (const command of [
      "ls; rm -rf /",
      "ls && npm install",
      "ls | tee out.txt",
      "cat $(rm -rf x)",
      "cat `whoami`",
      "ls > listing.txt",
      "cat < /etc/passwd",
      "ls & sleep 1",
    ]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
  });

  it("refuses a verb it does not know, rather than guessing", () => {
    // The whole point of an allowlist: a command nobody thought about is a
    // command that asks.
    for (const command of ["frobnicate --dry-run", "python -c 'print(1)'", "make"]) {
      expect(isReadOnlyCommand(command), command).toBe(false);
    }
  });

  it("refuses an empty or whitespace command", () => {
    expect(isReadOnlyCommand("")).toBe(false);
    expect(isReadOnlyCommand("   ")).toBe(false);
  });

  it("is not fooled by a path that ends in an allowed name", () => {
    // `/tmp/evil/ls` is not `ls`.
    expect(isReadOnlyCommand("/tmp/evil/ls")).toBe(false);
    expect(isReadOnlyCommand("./ls")).toBe(false);
  });
});
