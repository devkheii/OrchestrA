import type {
  PermissionDecision,
  PermissionMode,
  PermissionOutcome,
  PermissionRequest,
  SandboxHealth,
  ToolAction,
} from "@dem/protocol";

/**
 * Permission Broker (invariants 3, 7, 10, 21, 31; tests SEC-007, SEC-008).
 *
 * Permission and sandbox stay separate layers. The broker decides whether an
 * action may happen; the sandbox decides how far it reaches if it does.
 *
 * Every rule here narrows. Nothing in this file can make an action more
 * permissive than the base table, which is what the "never widens" test
 * asserts mechanically rather than by reading.
 */

const RANK: Record<PermissionOutcome, number> = { auto: 0, ask: 1, deny: 2 };

/** Returns the stricter of two outcomes. */
function tighten(a: PermissionOutcome, b: PermissionOutcome): PermissionOutcome {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Which permission modes the user may select given current sandbox health.
 *
 * An unhealthy sandbox degrades the ceiling; it never falls back to an
 * unprotected AUTO (invariant 21). In v0.1 no adapter ships, so this always
 * returns the first row.
 */
export function selectableModes(health: SandboxHealth): readonly PermissionMode[] {
  switch (health) {
    case "HEALTHY":
      return ["READ_ONLY", "ASK", "AUTO", "FULL_ACCESS"];
    case "DEGRADED":
    case "UNAVAILABLE":
    default:
      return ["READ_ONLY", "ASK"];
  }
}

/** Base table: what each mode permits with a healthy sandbox and a clean run. */
const BASE: Record<PermissionMode, Record<ToolAction, PermissionOutcome>> = {
  READ_ONLY: {
    read: "auto",
    search: "auto",
    patch: "deny",
    shell: "deny",
    terminal: "deny",
    network: "deny",
    counterexample_exec: "deny",
    destructive: "deny",
  },
  ASK: {
    read: "auto",
    search: "auto",
    patch: "ask",
    shell: "ask",
    terminal: "ask",
    network: "ask",
    counterexample_exec: "ask",
    destructive: "ask",
  },
  AUTO: {
    read: "auto",
    search: "auto",
    patch: "auto",
    shell: "auto",
    terminal: "auto",
    // Reading a file and sending it out are separate permissions (invariant 2),
    // so egress keeps asking even when execution does not.
    network: "ask",
    counterexample_exec: "auto",
    destructive: "ask",
  },
  FULL_ACCESS: {
    read: "auto",
    search: "auto",
    patch: "auto",
    shell: "auto",
    terminal: "auto",
    network: "auto",
    counterexample_exec: "auto",
    // Even here. "Full access" means the user stopped being asked about
    // ordinary work, not that `rm -rf /` proceeds unannounced.
    destructive: "ask",
  },
};

export function decide(request: PermissionRequest): PermissionDecision {
  const { action, mode, taint, sandbox } = request;

  // Model-authored code never runs without a healthy sandbox (invariant 31).
  if (action === "counterexample_exec" && sandbox !== "HEALTHY") {
    return {
      outcome: "deny",
      rule: "counterexample requires a healthy sandbox",
      invariant: 31,
    };
  }

  // A caller asking for AUTO without a sandbox to back it is refused rather
  // than trusted. selectableModes should have prevented this; defence in depth
  // costs one comparison (invariant 21).
  const effectiveMode: PermissionMode =
    sandbox !== "HEALTHY" && (mode === "AUTO" || mode === "FULL_ACCESS") ? "ASK" : mode;
  const downgradedBySandbox = effectiveMode !== mode;

  let outcome = BASE[effectiveMode][action];
  let rule = `${effectiveMode}/${action}`;
  let invariant: number | undefined = downgradedBySandbox ? 21 : undefined;

  if (downgradedBySandbox) rule = `${mode} downgraded to ASK: sandbox ${sandbox}`;

  // A tainted run is narrowed further (invariant 10). Only ever tightens.
  if (taint === "TAINTED") {
    const tainted = TAINT_CEILING[action];
    const narrowed = tighten(outcome, tainted);
    if (narrowed !== outcome) {
      outcome = narrowed;
      rule = `tainted run: ${action} limited to ${narrowed}`;
      invariant = 10;
    }
  }

  return invariant === undefined ? { outcome, rule } : { outcome, rule, invariant };
}

/**
 * The most permissive each action may be in a tainted run. Untrusted content
 * reached this context, so anything that writes, executes or leaves the
 * machine gets a human in the loop.
 */
const TAINT_CEILING: Record<ToolAction, PermissionOutcome> = {
  read: "auto",
  search: "auto",
  patch: "ask",
  shell: "ask",
  terminal: "ask",
  network: "ask",
  counterexample_exec: "ask",
  destructive: "deny",
};

/**
 * Split a compound shell command so each part is judged on its own.
 *
 * `rg foo && rm -rf /` must not be approved as one benign-looking unit, and
 * neither must `echo $(rm -rf ~)` — the substitution runs regardless of how
 * harmless the outer command looks. Quoted operators are left alone, because
 * `echo "a && b"` is genuinely one command.
 */
export function segmentCommand(command: string): string[] {
  const segments: string[] = [];
  const nested: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];

    if (quote) {
      // Single quotes suppress substitution; double quotes do not.
      if (quote === '"' && ch === "$" && next === "(") {
        const end = matchingParen(command, i + 1);
        if (end !== -1) {
          nested.push(...segmentCommand(command.slice(i + 2, end)));
          current += command.slice(i, end + 1);
          i = end;
          continue;
        }
      }
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === "$" && next === "(") {
      const end = matchingParen(command, i + 1);
      if (end !== -1) {
        nested.push(...segmentCommand(command.slice(i + 2, end)));
        current += command.slice(i, end + 1);
        i = end;
        continue;
      }
    }

    if (ch === "`") {
      const end = command.indexOf("`", i + 1);
      if (end !== -1) {
        nested.push(...segmentCommand(command.slice(i + 1, end)));
        current += command.slice(i, end + 1);
        i = end;
        continue;
      }
    }

    // Control operators. `&&` and `||` are consumed as pairs.
    if (ch === "&" || ch === "|" || ch === ";") {
      segments.push(current);
      current = "";
      if (next === ch) i++;
      continue;
    }

    current += ch;
  }

  segments.push(current);
  return [...segments, ...nested].map((s) => s.trim()).filter((s) => s.length > 0);
}

function matchingParen(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
