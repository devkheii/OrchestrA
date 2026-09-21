#!/usr/bin/env node
/**
 * A stand-in for `llama serve`: takes the same shape of arguments and opens a
 * port, so the launcher can be tested without a model or a GPU.
 *
 * `SCENARIO_EXIT` as the model path makes it fail during startup instead, the
 * way a real server does when it cannot load what it was given.
 *
 * `SCENARIO_SLOW_LOAD` binds the port immediately and answers completions with
 * 503 "Loading model" for a while, which is what llama.cpp and Ollama do while
 * weights are still coming off disk. The launcher treated an open port as
 * ready and handed the caller a server that refused every request for the next
 * minute.
 */

import { createServer } from "node:http";

const argv = process.argv.slice(2);
const portIndex = argv.indexOf("--port");
const modelIndex = argv.indexOf("-m");
const port = portIndex === -1 ? 0 : Number(argv[portIndex + 1]);
const model = modelIndex === -1 ? "" : argv[modelIndex + 1];

if (String(model).includes("SCENARIO_EXIT")) {
  process.stderr.write("error: failed to load model: unsupported file type\n");
  process.exit(1);
}

const slowLoad = String(model).includes("SCENARIO_SLOW_LOAD");
const loadedAt = Date.now() + (slowLoad ? Number(process.env["FAKE_LOAD_MS"] ?? 1500) : 0);

const server = createServer((req, res) => {
  const loading = Date.now() < loadedAt;

  // The listing answers throughout, which is exactly why it cannot be used as
  // a readiness probe.
  if ((req.url ?? "").includes("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [] }));
    return;
  }

  if (loading) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Loading model" } }));
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`listening on http://127.0.0.1:${port}\n`);
});
