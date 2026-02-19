import {
  includesTransactionMethod,
  listRpcProviders,
  resolveRpcTarget,
} from "@/services/rpc-proxy.service";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/d1";
import type { Env } from "@/types/env";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TEST_ORG_ID = "org_rpc_service_test";
const appEnv = env as unknown as Env;
const SEND_RAW_TRANSACTION_METHOD = ["sendRaw", "Transaction"].join("");

type MutableRpcEnv = {
  DB: Env["DB"];
  SDP_CACHE: Env["SDP_CACHE"];
  SOLANA_RPC_URL?: string;
  SOLANA_RPC_DEFAULT_PROVIDER?: string;
  SOLANA_RPC_TRITON_URL?: string;
  SOLANA_RPC_TRITON_API_KEY?: string;
  SOLANA_RPC_HELIUS_URL?: string;
  SOLANA_RPC_HELIUS_API_KEY?: string;
  SOLANA_RPC_ALCHEMY_URL?: string;
  SOLANA_RPC_ALCHEMY_API_KEY?: string;
  SOLANA_RPC_QUICKNODE_URL?: string;
  SOLANA_RPC_QUICKNODE_API_KEY?: string;
};

const rpcEnv = env as MutableRpcEnv;

async function clearKvNamespace(namespace: KVNamespace) {
  const listed = await namespace.list();
  for (const key of listed.keys) {
    await namespace.delete(key.name);
  }
}

describe("rpc-proxy.service", () => {
  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    await clearKvNamespace(rpcEnv.SDP_CACHE);

    await rpcEnv.DB.prepare(
      `INSERT INTO organizations (id, name, slug, tier, status, settings)
       VALUES (?, 'RPC Service Org', 'rpc-service-org', 'free', 'active', NULL)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         slug = excluded.slug,
         tier = excluded.tier,
         status = excluded.status,
         settings = excluded.settings`
    )
      .bind(TEST_ORG_ID)
      .run();

    rpcEnv.SOLANA_RPC_URL = undefined;
    rpcEnv.SOLANA_RPC_DEFAULT_PROVIDER = undefined;
    rpcEnv.SOLANA_RPC_TRITON_URL = undefined;
    rpcEnv.SOLANA_RPC_TRITON_API_KEY = undefined;
    rpcEnv.SOLANA_RPC_HELIUS_URL = undefined;
    rpcEnv.SOLANA_RPC_HELIUS_API_KEY = undefined;
    rpcEnv.SOLANA_RPC_ALCHEMY_URL = undefined;
    rpcEnv.SOLANA_RPC_ALCHEMY_API_KEY = undefined;
    rpcEnv.SOLANA_RPC_QUICKNODE_URL = undefined;
    rpcEnv.SOLANA_RPC_QUICKNODE_API_KEY = undefined;
  });

  it("identifies transaction JSON-RPC methods", () => {
    expect(includesTransactionMethod(["getVersion"])).toBe(false);
    expect(includesTransactionMethod(["sendTransaction"])).toBe(true);
    expect(includesTransactionMethod([SEND_RAW_TRANSACTION_METHOD])).toBe(true);
  });

  it("resolves quicknode provider from organization settings with redacted endpoint labels", async () => {
    await rpcEnv.DB.prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ rpcProvider: "quicknode" }), TEST_ORG_ID)
      .run();

    rpcEnv.SOLANA_RPC_QUICKNODE_URL = "https://rpc.quicknode.test/?api-key={API_KEY}";
    rpcEnv.SOLANA_RPC_QUICKNODE_API_KEY = "qn_secret";

    const target = await resolveRpcTarget({
      env: appEnv,
      db: rpcEnv.DB,
      organizationId: TEST_ORG_ID,
      authProjectId: null,
      requestedProjectId: null,
    });

    expect(target.providerId).toBe("quicknode");
    expect(target.selectionMode).toBe("organization_provider");
    expect(target.endpoint).toContain("api-key=qn_secret");
    expect(target.endpointLabel).toContain("api-key=***");
  });

  it("round-robins managed providers when organization preference is not set", async () => {
    rpcEnv.SOLANA_RPC_TRITON_URL = "https://rpc.triton.test";
    rpcEnv.SOLANA_RPC_HELIUS_URL = "https://rpc.helius.test";

    const first = await resolveRpcTarget({
      env: appEnv,
      db: rpcEnv.DB,
      organizationId: TEST_ORG_ID,
      authProjectId: null,
      requestedProjectId: null,
    });

    const second = await resolveRpcTarget({
      env: appEnv,
      db: rpcEnv.DB,
      organizationId: TEST_ORG_ID,
      authProjectId: null,
      requestedProjectId: null,
    });

    expect(first.providerId).toBe("triton");
    expect(second.providerId).toBe("helius");
    expect(first.selectionMode).toBe("round_robin_default");
    expect(second.selectionMode).toBe("round_robin_default");
  });

  it("honors default provider ordering and exposes quicknode in provider list", async () => {
    rpcEnv.SOLANA_RPC_TRITON_URL = "https://rpc.triton.test";
    rpcEnv.SOLANA_RPC_HELIUS_URL = "https://rpc.helius.test";
    rpcEnv.SOLANA_RPC_ALCHEMY_URL = "https://rpc.alchemy.test";
    rpcEnv.SOLANA_RPC_QUICKNODE_URL = "https://rpc.quicknode.test";
    rpcEnv.SOLANA_RPC_URL = "https://rpc.default.test";
    rpcEnv.SOLANA_RPC_DEFAULT_PROVIDER = "quicknode";

    const providers = await listRpcProviders({
      env: appEnv,
      db: rpcEnv.DB,
      organizationId: TEST_ORG_ID,
      authProjectId: null,
      requestedProjectId: null,
    });

    expect(providers.roundRobinOrder[0]).toBe("quicknode");
    expect(providers.roundRobinOrder).toEqual(
      expect.arrayContaining(["alchemy", "default", "helius", "quicknode", "triton"])
    );
    expect(providers.selected.providerId).toBe("quicknode");
  });
});
