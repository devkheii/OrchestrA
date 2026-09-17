import { NotImplemented } from "@dem/protocol";

/** Budget ceilings (SPEC section 24, invariant 28, test RUN-002). */
export interface Budget {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxWallTimeMs?: number;
  maxRemoteCost?: number;
  maxRounds?: number;
  maxCounterexampleExecutions?: number;
}

export interface BudgetUsage {
  inputTokens: number;
  outputTokens: number;
  wallTimeMs: number;
  remoteCost: number;
  rounds: number;
  counterexampleExecutions: number;
}

/**
 * Checked *before* execution, not after (invariant 28). A budget enforced
 * after the call has already spent the money it was meant to withhold.
 * Throws BudgetExceeded.
 */
export function assertWithinBudget(
  _budget: Budget,
  _usage: BudgetUsage,
  _projected: Partial<BudgetUsage>,
): void {
  throw new NotImplemented("assertWithinBudget", "RUN-002");
}
