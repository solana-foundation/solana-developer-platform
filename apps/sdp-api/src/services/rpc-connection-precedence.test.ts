import type {
  ResolveRpcTargetInput,
  TenantRpcConnectionLookup,
  TenantRpcConnectionResolution,
} from "@sdp/rpc/relay";
import { resolveRpcTarget } from "@sdp/rpc/relay";
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
  it("prefers a project connection over an organization one", async () => {
    const target = await resolve(
      lookupReturning({
        prj_1: activeConnection("rconn_project"),
        __organization__: activeConnection("rconn_org"),
      }),
      { authProjectId: "prj_1" }
    );

    expect(target.selectionMode).toBe("project_connection");
    expect(target.connectionId).toBe("rconn_project");
  });

  it("falls to the organization connection when the project has none", async () => {
    const target = await resolve(
      lookupReturning({ __organization__: activeConnection("rconn_org") }),
      { authProjectId: "prj_1" }
    );

    expect(target.selectionMode).toBe("organization_connection");
    expect(target.connectionId).toBe("rconn_org");
  });

  it("never carries the tenant key in the label it exposes", async () => {
    const target = await resolve(lookupReturning({ __organization__: activeConnection("rconn") }));

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

  it("fails closed on an unusable organization connection", async () => {
    await expect(
      resolve(
        lookupReturning({
          __organization__: { kind: "unusable", reason: "credential unavailable" },
        })
      )
    ).rejects.toThrow(/organization.*not active/i);
  });

  it("falls through to platform selection when no connection is configured", async () => {
    // The db stub throws on first contact, which is the proof that resolution
    // continued past the tenant branch rather than stopping at it.
    await expect(resolve(lookupReturning({}))).rejects.toThrow(FELL_THROUGH);
  });

  it("scopes every lookup to the caller's organization", async () => {
    const connections = lookupReturning({ __organization__: activeConnection("rconn_org") });
    await resolve(connections, { authProjectId: "prj_1" });

    for (const call of (connections.resolve as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0].organizationId).toBe("org_1");
      expect(["prj_1", "__organization__"]).toContain(call[0].scopeKey);
    }
  });

  it("re-reads the connection on every request so a rotation takes effect", async () => {
    const connections = lookupReturning({ __organization__: activeConnection("rconn_v1") });
    await resolve(connections);
    await resolve(connections);

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
});
