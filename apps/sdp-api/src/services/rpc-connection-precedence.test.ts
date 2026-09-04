import type {
  ResolveRpcTargetInput,
  TenantRpcConnectionLookup,
  TenantRpcConnectionResolution,
} from "@sdp/rpc/relay";
import {
  recordRpcRelayTelemetry,
  resolveRoundRobinRpcTargets,
  resolveRpcTarget,
} from "@sdp/rpc/relay";
import { describe, expect, it, vi } from "vitest";

/**
 * Precedence for HOO-1093, exercised without a database on purpose: the tenant
 * branch must resolve before any platform-managed lookup, so a stub that throws
 * on contact is how "did it fall through?" is answered honestly.
 */
const FELL_THROUGH = "FELL_THROUGH_TO_PLATFORM";

const db = {
  prepare() {
    throw new Error(FELL_THROUGH);
  },
} as unknown as ResolveRpcTargetInput["db"];

const kv = {
  cache: {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [] }),
  },
} as unknown as ResolveRpcTargetInput["kv"];

function activeConnection(
  connectionId: string,
  providerId: "helius" | "alchemy" = "helius"
): TenantRpcConnectionResolution {
  return {
    kind: "active",
    connectionId,
    providerId,
    endpoint: `https://tenant.example/${connectionId}?api-key=secret`,
    endpointLabel: `https://tenant.example/${connectionId}?api-key=***`,
    headers: {},
  };
}

function lookupReturning(
  byScope: Record<string, TenantRpcConnectionResolution>
): TenantRpcConnectionLookup {
  return {
    resolve: vi.fn(async ({ scopeKey }) => byScope[scopeKey] ?? { kind: "none" }),
  };
}

function resolve(
  connections: TenantRpcConnectionLookup,
  options: { authProjectId?: string | null } = {}
) {
  return resolveRpcTarget({
    env: { SOLANA_NETWORK: "devnet", SOLANA_RPC_URL: "https://platform.example" },
    kv,
    db,
    organizationId: "org_1",
    authProjectId: options.authProjectId ?? null,
    requestedProjectId: null,
    connections,
  });
}

describe("tenant RPC connection precedence", () => {
  it("resolves the project connection and never consults the organization", async () => {
    const connections = lookupReturning({
      prj_1: activeConnection("rconn_project"),
      __organization__: activeConnection("rconn_org"),
    });
    const target = await resolve(connections, { authProjectId: "prj_1" });

    expect(target.selectionMode).toBe("project_connection");
    expect(target.connectionId).toBe("rconn_project");
    // A live project connection short-circuits, so the organization scope is
    // not even read.
    const scopeKeys = (connections.resolve as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0].scopeKey
    );
    expect(scopeKeys).toEqual(["prj_1"]);
  });

  it("refuses to route when the connection is still organization-scoped", async () => {
    // HOO-1226 moved connections onto projects. The rows made before that are
    // no longer a rail, and answering on platform keys instead would be the
    // silent downgrade the tenant is paying their own provider to avoid.
    await expect(
      resolve(lookupReturning({ __organization__: activeConnection("rconn_org") }), {
        authProjectId: "prj_1",
      })
    ).rejects.toThrow(/no longer used/i);
  });

  it("never carries the tenant key in the label it exposes", async () => {
    const target = await resolve(lookupReturning({ prj_1: activeConnection("rconn") }), {
      authProjectId: "prj_1",
    });

    expect(target.endpointLabel).not.toContain("secret");
    expect(target.endpointLabel).toContain("***");
  });

  it("fails closed on an unusable project connection instead of spending platform keys", async () => {
    await expect(
      resolve(
        lookupReturning({
          prj_1: { kind: "unusable", reason: "no active default connection" },
          __organization__: activeConnection("rconn_org"),
        }),
        { authProjectId: "prj_1" }
      )
      // Critically it does not silently use the organization connection either.
    ).rejects.toThrow(/project.*not active/i);
  });

  it("fails closed on a stranded organization connection that is also broken", async () => {
    // Broken or working, it is stranded either way: the point is that neither
    // state quietly resolves to a platform provider.
    await expect(
      resolve(
        lookupReturning({
          __organization__: { kind: "unusable", reason: "credential unavailable" },
        })
      )
    ).rejects.toThrow(/no longer used/i);
  });

  it("falls through to platform selection when no connection is configured", async () => {
    // The db stub throws on first contact, which is the proof that resolution
    // continued past the tenant branch rather than stopping at it.
    await expect(resolve(lookupReturning({}))).rejects.toThrow(FELL_THROUGH);
  });

  it("refuses to answer on platform keys for an organization that is byok", async () => {
    // The organization has said its RPC leaves on its own credentials. Reaching
    // a platform provider here would be SDP paying for, and seeing, traffic
    // somebody deliberately moved off us.
    const connections = {
      ...lookupReturning({}),
      credentialMode: async () => "byok" as const,
    };

    await expect(resolve(connections, { authProjectId: "prj_1" })).rejects.toThrow(
      /runs RPC on its own credentials/i
    );
  });

  it("still falls through for an organization left on managed", async () => {
    const connections = {
      ...lookupReturning({}),
      credentialMode: async () => "managed" as const,
    };

    await expect(resolve(connections, { authProjectId: "prj_1" })).rejects.toThrow(FELL_THROUGH);
  });

  it("scopes every lookup to the caller's organization", async () => {
    const connections = lookupReturning({ prj_1: activeConnection("rconn_project") });
    await resolve(connections, { authProjectId: "prj_1" });

    for (const call of (connections.resolve as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0].organizationId).toBe("org_1");
      expect(["prj_1", "__organization__"]).toContain(call[0].scopeKey);
    }
  });

  it("re-reads the connection on every request so a rotation takes effect", async () => {
    const connections = lookupReturning({ prj_1: activeConnection("rconn_v1") });
    await resolve(connections, { authProjectId: "prj_1" });
    await resolve(connections, { authProjectId: "prj_1" });

    // No caching layer to invalidate: two requests, two reads.
    expect((connections.resolve as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it("ignores tenant connections entirely when no lookup is injected", async () => {
    await expect(
      resolveRpcTarget({
        env: { SOLANA_NETWORK: "devnet", SOLANA_RPC_URL: "https://platform.example" },
        kv,
        db,
        organizationId: "org_1",
        authProjectId: null,
        requestedProjectId: null,
      })
    ).rejects.toThrow(FELL_THROUGH);
  });

  it("routes the faucet path through a tenant connection too", async () => {
    // The airdrop branch resolves separately; leaving it on managed providers
    // let an organization on its own key still spend platform credentials.
    const targets = await resolveRoundRobinRpcTargets({
      env: { SOLANA_NETWORK: "devnet", SOLANA_RPC_URL: "https://platform.example" },
      kv,
      db,
      organizationId: "org_1",
      authProjectId: "prj_1",
      requestedProjectId: null,
      connections: lookupReturning({ prj_1: activeConnection("rconn_project") }),
    });

    expect(targets).toHaveLength(1);
    expect(targets[0].selectionMode).toBe("project_connection");
    expect(targets[0].connectionId).toBe("rconn_project");
  });

  it("fails the faucet path closed on an unusable connection", async () => {
    await expect(
      resolveRoundRobinRpcTargets({
        env: { SOLANA_NETWORK: "devnet", SOLANA_RPC_URL: "https://platform.example" },
        kv,
        db,
        organizationId: "org_1",
        authProjectId: "prj_1",
        requestedProjectId: null,
        connections: lookupReturning({
          prj_1: { kind: "unusable", reason: "no active default connection" },
        }),
      })
    ).rejects.toThrow(/not active/i);
  });

  it("still round-robins platform providers when no connection is configured", async () => {
    await expect(
      resolveRoundRobinRpcTargets({
        env: { SOLANA_NETWORK: "devnet", SOLANA_RPC_URL: "https://platform.example" },
        kv,
        db,
        organizationId: "org_1",
        authProjectId: null,
        requestedProjectId: null,
        connections: lookupReturning({}),
      })
    ).rejects.toThrow(FELL_THROUGH);
  });
});

/**
 * Telemetry buckets.
 *
 * A tenant connection resolves to the vendor's own id, so keying counters on
 * `providerId` alone mixed an organization's BYOK traffic into the platform's
 * bucket for that vendor, and the provider list reported requests SDP never
 * served as its own. Separation is asserted through the keys actually written.
 */
describe("relay telemetry keys", () => {
  function recordingCache() {
    const writes: string[] = [];
    const cache = {
      get: async () => null,
      put: async (key: string) => {
        writes.push(key);
      },
      delete: async () => undefined,
      list: async () => ({ keys: [] }),
    } as unknown as ResolveRpcTargetInput["kv"]["cache"];
    return { cache, writes };
  }

  const telemetry = {
    methodNames: ["getVersion"],
    statusCode: 200,
    latencyMs: 12,
    ok: true,
    origin: null,
  };

  it("keeps a tenant connection out of the platform provider's bucket", async () => {
    const { cache, writes } = recordingCache();

    await recordRpcRelayTelemetry(cache, {
      ...telemetry,
      providerId: "helius",
      connectionId: "rconn_1",
    });
    await recordRpcRelayTelemetry(cache, { ...telemetry, providerId: "helius" });

    expect(writes).toEqual(["rpc:relay:stats:tenant:rconn_1", "rpc:relay:stats:helius"]);
  });

  it("gives two organizations on the same vendor separate buckets", async () => {
    const { cache, writes } = recordingCache();

    await recordRpcRelayTelemetry(cache, {
      ...telemetry,
      providerId: "helius",
      connectionId: "rconn_org_a",
    });
    await recordRpcRelayTelemetry(cache, {
      ...telemetry,
      providerId: "helius",
      connectionId: "rconn_org_b",
    });

    expect(new Set(writes).size).toBe(2);
  });
});
