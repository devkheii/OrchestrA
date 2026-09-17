import { NotImplemented } from "@dem/protocol";

/**
 * Secret Broker (invariants 6 and 7; tests SEC-005, SEC-015).
 *
 * Secrets are referenced, never stored in config, and never inherited by a
 * child process. `secret.read` is deliberately not a tool: there is no path by
 * which a model can ask for a secret value, so no prompt can talk it into
 * handing one over.
 */

/** Environment variables a child process may inherit (plan 4.11). */
export const ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "Path",
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
  "SystemRoot",
  "COMSPEC",
  "ComSpec",
  "PATHEXT",
  "WINDIR",
  "NUMBER_OF_PROCESSORS",
];

/**
 * Patterns that must never reach a child even if somehow allowlisted. The
 * allowlist is the defence; this catches an allowlist edited carelessly later.
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
 * Build the child environment by allowlist, not by copying `process.env` and
 * deleting known-bad keys. The deletion approach fails open for every provider
 * variable nobody thought of — which is every provider added after the code
 * was written.
 */
export function sanitizeChildEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};

  for (const key of ENV_ALLOWLIST) {
    const value = parentEnv[key];
    if (value === undefined) continue;
    // Belt and braces: an allowlisted name that looks like a secret is dropped.
    if (ENV_DENY_PATTERNS.some((re) => re.test(key))) continue;
    child[key] = value;
  }

  return child;
}

/**
 * Redact known secret values from text before it reaches tool output, audit,
 * model context or a UI response (invariant 6).
 *
 * Value-based, not pattern-based. Guessing at what a secret looks like misses
 * the formats it has not seen; the broker knows exactly which strings it
 * handed out.
 */
export function redact(text: string, secretValues: readonly string[]): string {
  let out = text;
  for (const value of secretValues) {
    // An empty or near-empty value would match everywhere and turn the whole
    // transcript into masks, hiding the very output being inspected.
    if (value.length < 4) continue;
    out = out.split(value).join("[redacted]");
  }
  return out;
}

export type SecretRef = `secret://${string}` | `env://${string}`;

export function isSecretRef(value: string): value is SecretRef {
  return value.startsWith("secret://") || value.startsWith("env://");
}

export interface SecretBroker {
  /** Resolve a reference to a value, handed only to a provider/tool adapter. */
  resolve(ref: SecretRef): Promise<string>;
  /** Values handed out so far, so the redactor can scrub them. */
  knownValues(): readonly string[];
}

/**
 * v0.1 broker.
 *
 * `env://NAME` reads from the daemon's own environment — the development and
 * CI path. `secret://` needs an OS keychain, which is not implemented: doing
 * it properly means DPAPI on Windows and platform CLIs elsewhere, and a
 * half-working keychain that silently falls back to a file would be worse than
 * none, because the user would believe their key was in the keychain.
 */
export function createSecretBroker(env: NodeJS.ProcessEnv = process.env): SecretBroker {
  const handedOut = new Set<string>();

  return {
    async resolve(ref: SecretRef): Promise<string> {
      if (ref.startsWith("env://")) {
        const name = ref.slice("env://".length);
        const value = env[name];
        if (value === undefined) throw new Error(`secret reference ${ref} is not set`);
        handedOut.add(value);
        return value;
      }
      throw new NotImplemented(`OS keychain resolution for ${ref}`, "phase-2");
    },

    knownValues(): readonly string[] {
      return [...handedOut];
    },
  };
}
