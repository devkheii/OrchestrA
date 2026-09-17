import { CONFIG_PRECEDENCE } from "@dem/protocol";
import type { ConfigScope, PermissionMode, ScopedConfig, SecurityConfig } from "@dem/protocol";

/**
 * Config composition (SPEC section 33, invariant 29, test SEC-013).
 *
 * Two different operations live here on purpose:
 *
 *   mergeSettings()   ordinary precedence — higher authority wins outright
 *   composeSecurity() monotonic — a lower scope may tighten, never widen
 *
 * Collapsing them into one "merge" is the bug this module exists to prevent.
 * A workspace config is checked-in content the user may not have written and
 * may not have read; it must not be able to hand itself AUTO or switch remote
 * egress back on by being more specific than the user's own settings.
 */

/** Highest authority first, as declared in the SPEC. */
const AUTHORITY = new Map<ConfigScope, number>(CONFIG_PRECEDENCE.map((scope, i) => [scope, i]));

function authorityOf(scope: ConfigScope): number {
  return AUTHORITY.get(scope) ?? CONFIG_PRECEDENCE.length;
}

/** Ordinary, non-security settings. Highest-authority scope wins. */
export function mergeSettings(scopes: readonly ScopedConfig[]): Record<string, unknown> {
  const lowestFirst = [...scopes].sort((a, b) => authorityOf(b.scope) - authorityOf(a.scope));

  const merged: Record<string, unknown> = {};
  for (const scope of lowestFirst) {
    Object.assign(merged, scope.settings ?? {});
  }
  return merged;
}

/** Ordered from least to most permissive, so "minimum" means "strictest". */
const MODE_RANK: readonly PermissionMode[] = ["READ_ONLY", "ASK", "AUTO", "FULL_ACCESS"];

function strictestMode(a: PermissionMode, b: PermissionMode): PermissionMode {
  return MODE_RANK.indexOf(a) <= MODE_RANK.indexOf(b) ? a : b;
}

/**
 * Compose security so the result is never weaker than any contributing scope.
 *
 * Authority is deliberately absent here. Under monotonic composition it would
 * not change the answer, and consulting it would invite a future "but this
 * scope is higher, so let it override" that quietly breaks invariant 29.
 *
 *   denyCommands  union
 *   allowPaths    intersection
 *   maxMode       minimum
 *   remoteEgress  logical AND
 *
 * A scope that does not mention a field expresses no opinion on it and is
 * skipped, rather than counting as an empty allowlist that forbids everything.
 */
export function composeSecurity(scopes: readonly ScopedConfig[]): SecurityConfig {
  const denyCommands = new Set<string>();
  let allowPaths: string[] | undefined;
  // Local-first by default (invariant 1): egress is off unless something says on.
  let maxMode: PermissionMode = "ASK";
  let maxModeSeen = false;
  let remoteEgress = false;
  let remoteEgressSeen = false;

  for (const { security } of scopes) {
    if (!security) continue;

    for (const command of security.denyCommands ?? []) denyCommands.add(command);

    if (security.allowPaths !== undefined) {
      allowPaths =
        allowPaths === undefined
          ? [...security.allowPaths]
          : allowPaths.filter((p) => security.allowPaths!.includes(p));
    }

    if (security.maxMode !== undefined) {
      maxMode = maxModeSeen ? strictestMode(maxMode, security.maxMode) : security.maxMode;
      maxModeSeen = true;
    }

    if (security.remoteEgress !== undefined) {
      remoteEgress = remoteEgressSeen ? remoteEgress && security.remoteEgress : security.remoteEgress;
      remoteEgressSeen = true;
    }
  }

  return {
    denyCommands: [...denyCommands],
    allowPaths: allowPaths ?? [],
    maxMode,
    remoteEgress,
  };
}
