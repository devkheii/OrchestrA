import { NotImplemented } from "@dem/protocol";

/**
 * Secret Broker (invariants 6 and 7; tests SEC-005, SEC-015).
 *
 * Secrets are referenced, never stored in config, and never inherited by a
 * child process. `secret.read` is deliberately not a tool: there is no path
 * by which a model can ask for a secret value.
 */

/** Environment variables a child process may inherit (plan 4.11). */
export const ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
  "PWD",
  "TZ",
  "SYSTEMROOT",
  "COMSPEC",
];

/**
 * Patterns that must never reach a child, even if somehow allowlisted.
 * A denylist alone is not the defence — the allowlist is — but this catches
 * an allowlist edited carelessly later.
 */
export const ENV_DENY_PATTERNS: readonly RegExp[] = [
  /API_KEY$/i,
  /_TOKEN$/i,
  /SECRET/i,
  /PASSWORD/i,
  /CREDENTIAL/i,
  /^AWS_/i,
  /^ANTHROPIC_/i,
  /^OPENAI_/i,
];

/**
 * Build the child environment from the parent by allowlist, not by copying
 * `process.env` and deleting known-bad keys: the deletion approach fails open
 * for every provider variable nobody thought of.
 */
export function sanitizeChildEnv(_parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  throw new NotImplemented("sanitizeChildEnv", "SEC-005");
}

/**
 * Redact known secret values from text before it reaches tool output, audit,
 * model context or a UI response (invariant 6).
 */
export function redact(_text: string, _secretValues: readonly string[]): string {
  throw new NotImplemented("redact", "SEC-015");
}

export type SecretRef = `secret://${string}` | `env://${string}`;

export interface SecretBroker {
  /** Resolve a reference to a value, handed only to a provider/tool adapter. */
  resolve(ref: SecretRef): Promise<string>;
  /** Values currently known, so the redactor can scrub them. */
  knownValues(): readonly string[];
}
