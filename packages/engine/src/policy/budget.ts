import { BudgetExceeded } from "@dem/protocol";

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
  budget: Budget,
  usage: BudgetUsage,
  projected: Partial<BudgetUsage>,
): void {
  const checks: Array<[keyof BudgetUsage, number | undefined, string]> = [
    ["inputTokens", budget.maxInputTokens, "max_input_tokens"],
    ["outputTokens", budget.maxOutputTokens, "max_output_tokens"],
    ["wallTimeMs", budget.maxWallTimeMs, "max_wall_time"],
    ["remoteCost", budget.maxRemoteCost, "max_remote_cost"],
    ["rounds", budget.maxRounds, "max_rounds"],
    [
      "counterexampleExecutions",
      budget.maxCounterexampleExecutions,
      "max_counterexample_executions",
    ],
  ];

  for (const [field, ceiling, label] of checks) {
    // An unset ceiling means unlimited, not zero. Reading it as zero would
    // block every call the moment a budget object appeared anywhere.
    if (ceiling === undefined) continue;

    const after = usage[field] + (projected[field] ?? 0);
    if (after > ceiling) throw new BudgetExceeded(label, after, ceiling);
  }
}
