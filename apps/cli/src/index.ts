import { NotImplemented } from "@dem/protocol";

/**
 * `dem` CLI (plan 4.5). Reference UX; Web and Desktop are later shells over
 * the same daemon session.
 */
export function main(_argv: readonly string[]): Promise<number> {
  throw new NotImplemented("cli.main", "phase-1");
}
