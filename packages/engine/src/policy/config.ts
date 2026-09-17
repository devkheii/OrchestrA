import { NotImplemented } from "@dem/protocol";
import type { ScopedConfig, SecurityConfig } from "@dem/protocol";

/**
 * Config composition (SPEC section 33, invariant 29, test SEC-013).
 *
 * Two different operations live here on purpose:
 *
 *   mergeSettings()   ordinary precedence — higher scope wins outright
 *   composeSecurity() monotonic — a lower scope may tighten, never widen
 *
 * Collapsing them into one "merge" is the bug this module exists to prevent:
 * it would let a workspace config, which is checked-in content the user may
 * not have written, hand itself AUTO or re-enable remote egress.
 */

/** Ordinary, non-security settings. Highest-authority scope wins. */
export function mergeSettings(_scopes: readonly ScopedConfig[]): Record<string, unknown> {
  throw new NotImplemented("mergeSettings", "SEC-013");
}

/**
 * Compose security across scopes so the result is never weaker than any
 * contributing scope:
 *
 *   denyCommands  union
 *   allowPaths    intersection
 *   maxMode       minimum
 *   remoteEgress  logical AND
 */
export function composeSecurity(_scopes: readonly ScopedConfig[]): SecurityConfig {
  throw new NotImplemented("composeSecurity", "SEC-013");
}
