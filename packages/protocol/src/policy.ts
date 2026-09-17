/**
 * Permission, sandbox, trust and config-precedence types.
 *
 * Permission and sandbox are separate layers (invariant 3): permission answers
 * "may this happen at all", sandbox answers "how far can it reach if it does".
 */

/** SPEC section 19. */
export type PermissionMode = "READ_ONLY" | "ASK" | "AUTO" | "FULL_ACCESS";

/** Modes that require a healthy sandbox before they can be selected. */
export const SANDBOX_GATED_MODES: readonly PermissionMode[] = ["AUTO", "FULL_ACCESS"];

/** SPEC section 19.1. v0.1 ships no adapter, so health is always UNAVAILABLE. */
export type SandboxHealth = "HEALTHY" | "DEGRADED" | "UNAVAILABLE";

export interface SandboxProbe {
  health(): Promise<SandboxHealth>;
  /** Human-readable reason, surfaced in the CLI so the user knows their protection level. */
  detail(): Promise<string>;
}

/** SPEC section 18. Trust level of a context block. */
export type TrustLevel = "system" | "user" | "workspace" | "external";

/** Trust levels whose content may carry instructions. Everything else is data. */
export const INSTRUCTION_BEARING: readonly TrustLevel[] = ["system", "user"];

export interface ContextBlock {
  id: string;
  trust: TrustLevel;
  /** Where this came from: file path, URL, tool id. */
  origin: string;
  content: string;
  evidenceRefs?: string[];
}

/** A run is TAINTED once any `external` block reaches it (invariant 10). */
export type TaintState = "CLEAN" | "TAINTED";

export type ToolAction =
  | "read"
  | "search"
  | "patch"
  | "shell"
  | "terminal"
  | "network"
  | "counterexample_exec"
  | "destructive";

export type PermissionOutcome = "auto" | "ask" | "deny";

export interface PermissionRequest {
  action: ToolAction;
  mode: PermissionMode;
  taint: TaintState;
  sandbox: SandboxHealth;
  /** Raw command or path, used for segmentation and hard-deny matching. */
  subject: string;
}

export interface PermissionDecision {
  outcome: PermissionOutcome;
  /** Which rule produced this, for the audit trail. */
  rule: string;
  invariant?: number;
}

/**
 * Config precedence (SPEC section 33). Highest authority first.
 *
 * Environment sits directly below CLI so containers and CI have a working
 * injection channel; they frequently have no user config at all.
 */
export const CONFIG_PRECEDENCE = [
  "cli",
  "environment",
  "workspace",
  "user",
  "defaults",
] as const;

export type ConfigScope = (typeof CONFIG_PRECEDENCE)[number];

/**
 * Security settings compose monotonically (invariant 29): a lower-authority
 * scope may tighten a rule but never widen it. This is deliberately a
 * different operation from ordinary config override.
 */
export interface SecurityConfig {
  /** Commands that are always refused, at every scope. Union across scopes. */
  denyCommands: string[];
  /** Paths readable at all. Intersection across scopes. */
  allowPaths: string[];
  /** Highest selectable permission mode. Minimum across scopes. */
  maxMode: PermissionMode;
  /** Whether remote providers may be called at all. Logical AND across scopes. */
  remoteEgress: boolean;
}

export interface ScopedConfig {
  scope: ConfigScope;
  security?: Partial<SecurityConfig>;
  /** Non-security settings follow ordinary precedence. */
  settings?: Record<string, unknown>;
}
