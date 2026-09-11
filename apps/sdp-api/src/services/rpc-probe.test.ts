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
});
