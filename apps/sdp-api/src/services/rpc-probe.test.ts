import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { PROBE_MAX_RESPONSE_BYTES, probeRpcEndpoint } from "@/services/rpc-probe";

describe("probeRpcEndpoint managed branch", () => {
  it("bounds what it reads back from a configured endpoint", async () => {
    // Managed endpoints come from deployment config, which spares them the
    // egress guard — not the read bound: a misbehaving configured endpoint
    // must not buffer unbounded bytes into a health check.
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("x".repeat(PROBE_MAX_RESPONSE_BYTES * 4));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const result = await probeRpcEndpoint(
        { endpoint: `http://127.0.0.1:${port}/`, headers: {} },
        { enforcePublicEgress: false }
      );

      expect(result.upstream.status).toBe(200);
      expect(String(result.upstreamBody).length).toBeLessThanOrEqual(PROBE_MAX_RESPONSE_BYTES);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("releases the connection when the body reaches the bound exactly", async () => {
    // A body that fills the cap without ending must not leave the socket
    // held open until the probe timeout: the reader is cancelled the moment
    // the bound is reached, whichever chunking gets it there.
    let serverSocketClosed: Promise<void> = Promise.resolve();
    const server = createServer((req, res) => {
      serverSocketClosed = new Promise((resolve) => req.socket.once("close", () => resolve()));
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("x".repeat(PROBE_MAX_RESPONSE_BYTES));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const result = await probeRpcEndpoint(
        { endpoint: `http://127.0.0.1:${port}/`, headers: {} },
        { enforcePublicEgress: false }
      );
      expect(String(result.upstreamBody).length).toBe(PROBE_MAX_RESPONSE_BYTES);

      await Promise.race([
        serverSocketClosed,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("connection stayed open past the bound")), 2000)
        ),
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
