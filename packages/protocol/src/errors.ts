/**
 * Error types shared across the harness.
 *
 * `NotImplemented` exists so that Phase 0 tests fail for a *declared* reason
 * rather than a missing import. A red test that throws NotImplemented is
 * proving the contract is wired; a red test that throws ReferenceError is
 * proving nothing. See docs/IMPLEMENTATION_PLAN.md section 3.
 */

export class NotImplemented extends Error {
  readonly code = "NOT_IMPLEMENTED" as const;
  /** SPEC section or test ID this stub is waiting on. */
  readonly contract: string;

  constructor(what: string, contract: string) {
    super(`not implemented: ${what} (contract: ${contract})`);
    this.name = "NotImplemented";
    this.contract = contract;
  }
}

/** A hard policy boundary was hit. Never catchable into a silent fallback. */
export class PolicyViolation extends Error {
  readonly code = "POLICY_VIOLATION" as const;
  /** Invariant number from SPEC section 2. */
  readonly invariant: number;

  constructor(message: string, invariant: number) {
    super(message);
    this.name = "PolicyViolation";
    this.invariant = invariant;
  }
}

/** Caller is not authenticated. Applies to every endpoint (invariant 4). */
export class Unauthenticated extends Error {
  readonly code = "UNAUTHENTICATED" as const;
  constructor(message = "authentication required") {
    super(message);
    this.name = "Unauthenticated";
  }
}

/** Optimistic concurrency failure on a workspace write (invariant 26). */
export class StaleWrite extends Error {
  readonly code = "STALE_WRITE" as const;
  constructor(
    readonly path: string,
    readonly expectedHash: string,
    readonly actualHash: string,
  ) {
    super(`stale write: ${path} expected ${expectedHash} but found ${actualHash}`);
    this.name = "StaleWrite";
  }
}

/** A budget ceiling was reached before execution (invariant 28). */
export class BudgetExceeded extends Error {
  readonly code = "BUDGET_EXCEEDED" as const;
  constructor(
    readonly limit: string,
    readonly used: number,
    readonly max: number,
  ) {
    super(`budget exceeded: ${limit} ${used}/${max}`);
    this.name = "BudgetExceeded";
  }
}
