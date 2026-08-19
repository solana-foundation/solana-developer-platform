import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EgressBlockedError } from "@/services/guarded-egress";
import { checkResolvedRpcTargetConnection } from "@/services/provider-setup-registry";
import { fetchRpcRelayTarget } from "@/services/rpc-egress";

/**
 * Both directions matter. A guard that refused everything would pass a
 * blocklist test and take local development and the Surfpool suites down with
 * it, so each path is asserted to reach a private address when the target is
 * platform-owned and to refuse when it is tenant-owned.
 */
let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: "probe", result: { "solana-core": "0.0.0" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("fetchRpcRelayTarget", () => {
  it("relays a platform target to a private address", async () => {
    // The platform rail has to keep working against a local validator.
    const upstream = await fetchRpcRelayTarget(
      { endpoint: origin },
      { headers: { "Content-Type": "application/json" }, body: "{}" }
    );

    expect(upstream.status).toBe(200);
  });

  it("refuses a custom target whose host resolves inward", async () => {
    // `custom` is the project's own stored endpoint, validated only as a URL
    // when it is written and carrying no connectionId. It is as much a
    // customer-supplied host as a BYOK connection.
    await expect(
      fetchRpcRelayTarget(
        {
          endpoint: `https://localhost:${(server.address() as AddressInfo).port}/`,
          providerId: "custom",
        },
        { headers: { "Content-Type": "application/json" }, body: "{}" }
      )
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("refuses a tenant target whose host resolves inward", async () => {
    // Same destination, only the connectionId differs, which is the whole
    // rule: a target a customer supplied does not get to name an internal
    // address by way of a name that resolves to one.
    await expect(
      fetchRpcRelayTarget(
        {
          endpoint: `https://localhost:${(server.address() as AddressInfo).port}/`,
          connectionId: "rconn_test",
        },
        { headers: { "Content-Type": "application/json" }, body: "{}" }
      )
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });
});

describe("checkResolvedRpcTargetConnection", () => {
  const base = {
    providerId: "helius" as const,
    projectId: null,
    endpointLabel: "local",
    headers: {},
    selectionMode: "organization_provider" as const,
  };

  it("probes a platform target at a private address", async () => {
    // A managed provider's endpoint comes from deployment config, which is
    // what local development and the Surfpool suites rely on.
    const { upstream } = await checkResolvedRpcTargetConnection({
      target: { ...base, endpoint: origin },
    });

    expect(upstream.status).toBe(200);
  });

  it("refuses to probe the project's own custom endpoint when it resolves inward", async () => {
    await expect(
      checkResolvedRpcTargetConnection({
        target: {
          ...base,
          providerId: "custom",
          endpoint: `https://localhost:${(server.address() as AddressInfo).port}/`,
          selectionMode: "project_custom_provider",
        },
      })
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("refuses to probe a tenant target that resolves inward", async () => {
    // POST /v1/rpc/test resolves tenant connections, so this path reaches a
    // customer endpoint whenever one is active.
    await expect(
      checkResolvedRpcTargetConnection({
        target: {
          ...base,
          endpoint: `https://localhost:${(server.address() as AddressInfo).port}/`,
          connectionId: "rconn_test",
        },
      })
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });
});
