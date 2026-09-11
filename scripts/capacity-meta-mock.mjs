#!/usr/bin/env node

import { createServer } from "node:http";

const port = Number(process.env.CAPACITY_META_MOCK_PORT ?? 4100);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("CAPACITY_META_MOCK_PORT must be an integer from 1 through 65535");
}

let providerCalls = 0;
const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "up" }));
    return;
  }

  if (request.method !== "POST" || !request.url?.endsWith("/messages")) {
    request.resume();
    response.statusCode = 404;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  try {
    for await (const _chunk of request) {
      // Drain the bounded request body without retaining customer-like payloads in this test seam.
    }
    providerCalls += 1;
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ messages: [{ id: `wamid.hosted.${providerCalls}` }] }));
  } catch {
    response.statusCode = 500;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "mock_failure" }));
  }
});

const close = () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", close);
process.on("SIGINT", close);

server.listen(port, "127.0.0.1", () => {
  process.stderr.write(`[capacity-meta-mock] ready port=${port}\n`);
});
