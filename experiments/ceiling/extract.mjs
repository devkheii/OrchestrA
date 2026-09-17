/**
 * Pull the Python out of a chat answer.
 *
 * This is the quiet way to get a wrong result. Extraction that works for one
 * model and not the other produces a difference between models that is really
 * a difference between parsers, and the ceiling is a difference between models.
 * So: the same extractor for both, and every response that yields nothing is
 * counted and reported rather than scored as a failed solution.
 */

const FENCE = /```(?:python|py)?\s*\n([\s\S]*?)```/gi;

export function extractCode(answer) {
  if (!answer) return null;

  // Fenced blocks first, and the longest one rather than the first: a model
  // that shows a usage example after its answer would otherwise be graded on
  // the example.
  const blocks = [...answer.matchAll(FENCE)].map((m) => m[1].trim()).filter(Boolean);
  if (blocks.length) {
    const withDef = blocks.filter((b) => /^\s*(def|from|import|class)\s/m.test(b));
    const pool = withDef.length ? withDef : blocks;
    return pool.reduce((a, b) => (b.length > a.length ? b : a));
  }

  // Unfenced, but starting at a definition. Anything before it is prose.
  const start = answer.search(/^\s*(from|import|def|class)\s/m);
  if (start >= 0) return answer.slice(start).trim();

  return null;
}

/**
 * The program that gets graded.
 *
 * The original prompt is NOT prepended: it ends in a docstring with no body,
 * so concatenating it with a complete function is a syntax error. Its import
 * lines are kept, because a model that uses `List[int]` in a signature is
 * relying on an import the prompt already made for it.
 */
export function buildProgram(task, code) {
  const imports = task.prompt
    .split("\n")
    .filter((l) => /^\s*(from|import)\s/.test(l))
    .join("\n");

  return [
    "from typing import *",
    imports,
    "",
    code,
    "",
    task.test,
    "",
    `check(${task.entry_point})`,
    "",
  ].join("\n");
}
