import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EgressBlockedError } from "@/services/guarded-egress";
import { checkResolvedRpcTargetConnection } from "@/services/provider-setup-registry";

/**
 * `POST /v1/rpc/test` probes whatever endpoint the target resolved to, and for
 * the `custom` provider that is `projects.settings.rpcEndpoint`, a URL a
 * customer typed in and which is validated as a URL and nothing more.
 *
 * Both directions matter: a guard that refused everything would pass the first
 * case here and take local development and the Surfpool suites down with it.
 */
let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: "rpc-connectivity-test", result: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const base = {
  projectId: null,
  endpointLabel: "local",
  headers: {},
  selectionMode: "organization_provider" as const,
};

describe("checkResolvedRpcTargetConnection", () => {
  it("probes a managed provider at a private address", async () => {
    const { upstream } = await checkResolvedRpcTargetConnection({
      target: { ...base, providerId: "helius", endpoint: origin },
    });

    expect(upstream.status).toBe(200);
  });

  it("refuses a custom endpoint whose host resolves inward", async () => {
    await expect(
      checkResolvedRpcTargetConnection({
        target: {
          ...base,
          providerId: "custom",
          selectionMode: "project_custom_provider",
          endpoint: `https://localhost:${(server.address() as AddressInfo).port}/`,
        },
      })
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });
});
