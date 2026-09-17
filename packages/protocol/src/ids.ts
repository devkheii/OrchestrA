/**
 * Namespaced identifiers (SPEC section 15).
 *
 * The prefix is what lets `dem log <id>` take a single argument without
 * guessing whether it was handed a session or a decision.
 */

export const ID_PREFIX = {
  session: "ses",
  decision: "dec",
  objection: "obj",
  evidence: "ev",
  artifact: "art",
  job: "job",
  workload: "wl",
} as const;

export type IdKind = keyof typeof ID_PREFIX;

export type Id<K extends IdKind = IdKind> = `${(typeof ID_PREFIX)[K]}_${string}`;

export type SessionId = Id<"session">;
export type DecisionId = Id<"decision">;
export type ObjectionId = Id<"objection">;
export type EvidenceId = Id<"evidence">;
export type ArtifactId = Id<"artifact">;
export type JobId = Id<"job">;
export type WorkloadId = Id<"workload">;

const PREFIX_TO_KIND: ReadonlyMap<string, IdKind> = new Map(
  Object.entries(ID_PREFIX).map(([kind, prefix]) => [prefix, kind as IdKind]),
);

/** Parse an id into its kind, or null when the prefix is unknown. */
export function idKind(id: string): IdKind | null {
  const sep = id.indexOf("_");
  if (sep <= 0) return null;
  return PREFIX_TO_KIND.get(id.slice(0, sep)) ?? null;
}

export function isId<K extends IdKind>(id: string, kind: K): id is Id<K> {
  return idKind(id) === kind;
}

/**
 * Mint an id. `random` is injected so tests can make ids deterministic
 * without stubbing global crypto.
 */
export function makeId<K extends IdKind>(kind: K, random: () => string): Id<K> {
  return `${ID_PREFIX[kind]}_${random()}` as Id<K>;
}
