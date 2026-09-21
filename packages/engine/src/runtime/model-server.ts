import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { killProcessTree } from "./kill.js";

/**
 * Starting a local model server when one is configured but not running.
 *
 * Without this, using a local model means a second terminal, a remembered port
 * and a `baseUrl` kept in sync with it by hand. For a harness whose first
 * principle is local-first, that made the local path the most awkward one.
 *
 * Only ever loopback, and only ever a binary the user named. The harness does
 * not go looking for something to run.
 */

export interface ModelServerConfig {
  /** Path to a .gguf. Absent means the user is running their own server. */
  modelPath?: string | undefined;
  /** Defaults to `llama`, which is what the llama.cpp installer puts on PATH. */
  command?: string | undefined;
  /** Args before the subcommand, e.g. a script path when command is node. */
  commandArgs?: readonly string[] | undefined;
  contextSize?: number | undefined;
  /** Extra flags, for a user who knows their hardware better than we do. */
  extraArgs?: readonly string[] | undefined;
  startupTimeoutMs?: number | undefined;
  /** Told when the wait moves from "opening a port" to "loading weights". */
  onProgress?: ((note: string) => void) | undefined;
}

export interface ModelServer {
  baseUrl: string;
  /** False when a server was already listening and we attached to it. */
  started: boolean;
  stop(): Promise<void>;
}

/**
 * Ensure something is listening at `baseUrl`, starting a server if not.
 *
 * An already-running server is left alone and reused: a user who started one
 * deliberately, with flags tuned for their hardware, should not have it
 * duplicated or replaced by our guess.
 */
export async function ensureModelServer(
  baseUrl: string,
  config: ModelServerConfig,
): Promise<ModelServer> {
  if (await isListening(baseUrl)) {
    return { baseUrl, started: false, stop: async () => {} };
  }

  if (!config.modelPath) {
    throw new Error(
      `no model server at ${baseUrl}, and no modelPath configured to start one. ` +
        `Either start a server yourself, or set "modelPath" in .dem/config.json.`,
    );
  }
  if (!existsSync(config.modelPath)) {
    throw new Error(`modelPath does not exist: ${config.modelPath}`);
  }

  const port = portOf(baseUrl);
  const command = config.command ?? "llama";
  const args = [
    ...(config.commandArgs ?? []),
    "serve",
    "-m",
    config.modelPath,
    "--port",
    String(port),
    ...(config.contextSize ? ["-c", String(config.contextSize)] : []),
    ...(config.extraArgs ?? []),
  ];

  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

  let startupLog = "";
  child.stdout.on("data", (d: Buffer) => (startupLog += d.toString()));
  child.stderr.on("data", (d: Buffer) => (startupLog += d.toString()));

  const failed = new Promise<never>((_, reject) => {
    child.on("error", (err) =>
      reject(new Error(`could not start ${command}: ${err.message}`)),
    );
    child.on("exit", (code) =>
      // A server that exits during startup has a reason in its output, and
      // that reason is far more useful than "timed out waiting for a port".
      reject(new Error(`${command} exited ${code} during startup:\n${startupLog.slice(-1500)}`)),
    );
  });

  const stop = async (): Promise<void> => {
    if (child.pid !== undefined) killProcessTree(child.pid);
  };

  try {
    await Promise.race([
      waitForReady(baseUrl, config.startupTimeoutMs ?? 180_000, config.onProgress),
      failed,
    ]);
  } catch (err) {
    await stop();
    throw err;
  }

  return { baseUrl, started: true, stop };
}

/** Whether anything accepts a TCP connection at the URL's host and port. */
export function isListening(baseUrl: string): Promise<boolean> {
  const { hostname, port } = new URL(baseUrl);

  return new Promise((resolve) => {
    const socket = createServer();
    // Binding the port is the reliable probe on every platform: if the bind
    // succeeds nothing was there, and a failed connect can also mean a
    // firewall rather than an absence.
    socket.once("error", () => resolve(true));
    socket.once("listening", () => socket.close(() => resolve(false)));
    socket.listen(Number(port), hostname);
  });
}

/**
 * Wait until the server will actually answer, not until its port is open.
 *
 * Those are different moments and the gap is the whole load time of the
 * weights. llama.cpp and Ollama bind the port immediately, answer `/v1/models`
 * throughout, and return 503 "Loading model" to completions until the model is
 * in memory — so a caller told "ready" when the socket accepted got a server
 * that refused everything for the next minute. In this harness that reached
 * the user as "your model answered 0 of 5 trivial questions", which blames the
 * model for the launcher's impatience.
 */
async function waitForReady(
  baseUrl: string,
  timeoutMs: number,
  onProgress?: ((note: string) => void) | undefined,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  // First the port, since there is nothing to ask until something accepts.
  while (!(await isListening(baseUrl))) {
    if (Date.now() >= deadline) {
      throw new Error(`model server did not start listening at ${baseUrl} within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  onProgress?.("loading the model");

  // Then the endpoint the caller is actually going to use.
  for (;;) {
    const status = await probeCompletions(baseUrl);
    if (status !== "loading") return;

    if (Date.now() >= deadline) {
      throw new Error(
        `model server at ${baseUrl} was still loading after ${Math.round(timeoutMs / 1000)}s. ` +
          `Large weights on a slow disk can take longer; raise the timeout, or start the ` +
          `server yourself and let dem attach to it.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * One cheap request, read only for whether the server is still loading.
 *
 * Anything that is not a 503 means the server is answering: a 200, a 400 about
 * the request shape, a 404 from a gateway. Waiting for correctness here would
 * duplicate the smoke test (§25.3), which runs next and is where a wrong
 * answer belongs.
 */
async function probeCompletions(baseUrl: string): Promise<"loading" | "answering"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(`${trimEnd(baseUrl)}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "ready?" }], max_tokens: 1 }),
      signal: controller.signal,
    });
    return res.status === 503 ? "loading" : "answering";
  } catch {
    // Refused or timed out mid-load: it was listening a moment ago, so this is
    // a server still getting itself together rather than one that is gone.
    return "loading";
  } finally {
    clearTimeout(timer);
  }
}

function trimEnd(url: string): string {
  return url.replace(/\/+$/, "");
}

function portOf(baseUrl: string): number {
  const port = Number(new URL(baseUrl).port);
  if (!port) throw new Error(`baseUrl must name a port to start a server: ${baseUrl}`);
  return port;
}
