import { NotImplemented } from "@dem/protocol";
import type {
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  SandboxHealth,
} from "@dem/protocol";

/**
 * Permission Broker (invariants 3, 7, 21; tests SEC-008, SEC-007).
 *
 * Permission and sandbox stay separate layers. The broker decides whether an
 * action may happen; the sandbox decides how far it reaches if it does. In
 * v0.1 there is no sandbox adapter, so `selectableModes` returns ASK at most
 * and AUTO is unreachable (SPEC section 19.1).
 */

/**
 * Which permission modes the user may select given current sandbox health.
 * Never widens on a failed probe: an unhealthy sandbox degrades to ASK or
 * READ_ONLY rather than falling back to an unprotected AUTO (invariant 21).
 */
export function selectableModes(_health: SandboxHealth): readonly PermissionMode[] {
  throw new NotImplemented("selectableModes", "SEC-008");
}

/** Decide a single action. Every tool call passes through here (invariant 7). */
export function decide(_request: PermissionRequest): PermissionDecision {
  throw new NotImplemented("decide", "SEC-008");
}

/**
 * Split a compound shell command on control operators so each segment is
 * evaluated on its own (SPEC section 19). `rg foo && rm -rf /` must not be
 * approved as one benign-looking unit.
 */
export function segmentCommand(_command: string): string[] {
  throw new NotImplemented("segmentCommand", "SEC-008");
}
