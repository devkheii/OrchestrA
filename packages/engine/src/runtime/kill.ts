import { spawn } from "node:child_process";

/**
 * Process termination (invariant 27; tests SEC-005, RUN-001).
 *
 * Cancel has to be both fast and thorough, and on Windows those pull apart.
 *
 * POSIX gets both: the child is spawned `detached`, so a negative pid kills
 * the whole group at once, instantly.
 *
 * Windows has no process groups here. `taskkill /t /f` walks the tree, but on
 * a managed host it can be very slow — measured at a consistent ~3.8s on the
 * machine this was developed on, presumably endpoint security inspecting each
 * spawn. Waiting for it would mean every cancel and every timeout stalls for
 * four seconds, which is unusable in an interactive CLI.
 *
 * So Windows does both: the direct child is terminated immediately, and the
 * tree walk is fired without being awaited. The caller gets a prompt, truthful
 * answer about the process it started. A deep tree can still leave an orphan
 * there; WSL2, the reference environment (SPEC section 19), does not have the
 * problem at all.
 */

export interface KillOutcome {
  /** The direct child was signalled. */
  signalled: boolean;
  /** A tree walk was started. On Windows it completes asynchronously. */
  treeKillStarted: boolean;
}

export function killProcessTree(pid: number): KillOutcome {
  if (process.platform === "win32") {
    let treeKillStarted = false;
    try {
      // Detached and unref'd: its slowness must not hold the run open.
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      killer.on("error", () => {});
      killer.unref();
      treeKillStarted = true;
    } catch {
      // No taskkill available; the direct kill below still applies.
    }

    let signalled = false;
    try {
      process.kill(pid, "SIGKILL");
      signalled = true;
    } catch {
      // Already gone, which is the outcome we wanted.
    }
    return { signalled, treeKillStarted };
  }

  // Negative pid targets the process group created by `detached: true`.
  try {
    process.kill(-pid, "SIGKILL");
    return { signalled: true, treeKillStarted: true };
  } catch {
    try {
      process.kill(pid, "SIGKILL");
      return { signalled: true, treeKillStarted: false };
    } catch {
      return { signalled: false, treeKillStarted: false };
    }
  }
}
