import app from "@/index";
import { hashString } from "@/lib/hash";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/d1";
import { clearKVNamespaces, seedCachedApiKey } from "@/test/mocks/kv";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_CONFIG_ID = "cust_cfg_payments_test";
const TEST_CUSTODY_WALLET_ID = "cwlt_payments_test";
const TEST_WALLET_ID = "wal_payments_test";
const TEST_ORG = {
  id: "org_payments_policy_test",
  name: "Payments Policy Test Org",
  slug: "payments-policy-test-org",
};
const TEST_USER = {
  id: "usr_payments_policy_test",
  email: "payments-policy-test@example.com",
};
const TEST_API_KEY = {
  id: "key_payments_policy_test",
  // biome-ignore lint/nursery/noSecrets: Test fixture, not a real secret.
  raw: "sk_test_paymentspolicy12345678901234567890",
  prefix: "sk_test_pay",
};
const TEST_CACHED_API_KEY: CachedApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: null,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

async function seedAuthAndWallet(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);

  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)"
    ).bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "free", "active"),
    env.DB.prepare(
      "INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)"
    ).bind(TEST_USER.id, TEST_USER.email, 1, "active"),
    env.DB.prepare(
      `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, environment, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      TEST_API_KEY.id,
      TEST_ORG.id,
      null,
      TEST_USER.id,
      "Payments Test Key",
      TEST_API_KEY.prefix,
      keyHash,
      "api_admin",
      JSON.stringify(["*"]),
      "sandbox",
      "active"
    ),
    env.DB.prepare(
      `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      TEST_CONFIG_ID,
      TEST_ORG.id,
      null,
      "local",
      "test-config",
      "sdp-custody-encryption-v1",
      TEST_WALLET_ID,
      "active"
    ),
    env.DB.prepare(
      `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      TEST_CUSTODY_WALLET_ID,
      TEST_CONFIG_ID,
      TEST_WALLET_ID,
      TEST_SOLANA_ADDRESSES.wallet1,
      "Payments Wallet",
      "transfer",
      "active"
    ),
  ]);
}

async function seedWalletPolicy(params: {
  destinationAllowlist: string[];
  maxTransferAmount?: string;
  maxDailyAmount?: string;
}): Promise<void> {
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO payment_wallet_policies
           (id, custody_wallet_id, policy_type, policy, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      "pwp_allowlist_test",
      TEST_CUSTODY_WALLET_ID,
      "destination_allowlist",
      JSON.stringify({
        version: 1,
        destinationAllowlist: params.destinationAllowlist,
      }),
      now,
      now
    ),
    env.DB.prepare(
      `INSERT INTO payment_wallet_policies
           (id, custody_wallet_id, policy_type, policy, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      "pwp_limits_test",
      TEST_CUSTODY_WALLET_ID,
      "transfer_limits",
      JSON.stringify({
        version: 1,
        maxTransferAmount: params.maxTransferAmount ?? null,
        maxDailyAmount: params.maxDailyAmount ?? null,
      }),
      now,
      now
    ),
  ]);
}

type JsonRpcRequest = {
  id: string | number;
  method: string;
  params?: unknown[];
};

function jsonRpcResult(id: string | number, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function mockRpcFetch(
  resolver: (
    request: JsonRpcRequest
  ) => Promise<{ jsonrpc: string; id: string | number; result: unknown }>
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;

    if (Array.isArray(body)) {
      const responses = await Promise.all(
        body.map((request) => resolver(request as JsonRpcRequest))
      );
      return new Response(JSON.stringify(responses), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const response = await resolver(body as JsonRpcRequest);
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function signatureRow(input: {
  signature: string;
  slot: number;
  blockTime: number;
  confirmationStatus?: "processed" | "confirmed" | "finalized";
  err?: unknown;
}) {
  return {
    signature: input.signature,
    slot: input.slot,
    err: input.err ?? null,
    confirmationStatus: input.confirmationStatus ?? "confirmed",
    blockTime: input.blockTime,
  };
}

function solTransferTx(input: {
  slot: number;
  blockTime: number;
  source: string;
  destination: string;
  lamports: string;
}) {
  return {
    slot: input.slot,
    blockTime: input.blockTime,
    meta: {
      fee: 5000,
      err: null,
    },
    transaction: {
      message: {
        accountKeys: [input.source, input.destination],
        instructions: [
          {
            parsed: {
              type: "transfer",
              info: {
                source: input.source,
                destination: input.destination,
                lamports: input.lamports,
              },
            },
          },
        ],
      },
    },
  };
}

function splTransferTx(input: {
  slot: number;
  blockTime: number;
  source: string;
  destination: string;
  mint: string;
  uiAmount: string;
}) {
  return {
    slot: input.slot,
    blockTime: input.blockTime,
    meta: {
      fee: 5000,
      err: null,
    },
    transaction: {
      message: {
        accountKeys: [input.source, input.destination, input.mint],
        instructions: [
          {
            parsed: {
              type: "transferChecked",
              info: {
                source: input.source,
                destination: input.destination,
                authority: input.source,
                mint: input.mint,
                tokenAmount: {
                  uiAmountString: input.uiAmount,
                },
              },
            },
          },
        ],
      },
    },
  };
}

describe("Payments routes", () => {
  beforeEach(async () => {
    if (!(env as { SOLANA_RPC_URL?: string }).SOLANA_RPC_URL) {
      (env as { SOLANA_RPC_URL?: string }).SOLANA_RPC_URL = "https://rpc.invalid.test";
    }

    await seedTestDatabase(env);
    await seedAuthAndWallet();
  });

  afterEach(async () => {
    await clearTestDatabase(env);
    await clearKVNamespaces(env);
    vi.restoreAllMocks();
  });

  it("blocks prepare transfer when destination is outside allowlist", async () => {
    await seedWalletPolicy({
      destinationAllowlist: [TEST_SOLANA_ADDRESSES.wallet2],
    });

    const res = await app.request(
      "/v1/payments/transfers/prepare",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet3,
          token: "SOL",
          amount: "1",
        }),
      },
      env
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");

    const transfers = await env.DB.prepare("SELECT id FROM payment_transfers").all<{
      id: string;
    }>();
    expect(transfers.results).toHaveLength(0);
  });

  it("blocks prepare transfer when amount exceeds maxTransferAmount", async () => {
    await seedWalletPolicy({
      destinationAllowlist: [],
      maxTransferAmount: "1.5",
    });

    const res = await app.request(
      "/v1/payments/transfers/prepare",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: "SOL",
          amount: "2.0",
        }),
      },
      env
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");

    const transfers = await env.DB.prepare("SELECT id FROM payment_transfers").all<{
      id: string;
    }>();
    expect(transfers.results).toHaveLength(0);
  });

  it("blocks create transfer when projected daily total exceeds maxDailyAmount", async () => {
    await seedWalletPolicy({
      destinationAllowlist: [],
      maxDailyAmount: "2.0",
    });

    const fetchSpy = mockRpcFetch(async (request) => {
      // biome-ignore lint/nursery/noSecrets: JSON-RPC method literal in test fixture.
      if (request.method === "getSignaturesForAddress") {
        return jsonRpcResult(request.id, []);
      }
      return jsonRpcResult(request.id, null);
    });

    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO payment_transfers
           (id, organization_id, project_id, wallet_id, source_address, destination_address, token, amount, memo, type, direction, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        "xfr_existing_daily_limit",
        TEST_ORG.id,
        null,
        TEST_WALLET_ID,
        TEST_SOLANA_ADDRESSES.wallet1,
        TEST_SOLANA_ADDRESSES.wallet2,
        "SOL",
        "1.4",
        null,
        "transfer",
        "outbound",
        "pending",
        now,
        now
      )
      .run();

    const res = await app.request(
      "/v1/payments/transfers",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet3,
          token: "SOL",
          amount: "0.7",
        }),
      },
      env
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");

    const transfers = await env.DB.prepare("SELECT id FROM payment_transfers ORDER BY id ASC").all<{
      id: string;
    }>();
    expect(transfers.results).toHaveLength(1);
    expect(transfers.results[0]?.id).toBe("xfr_existing_daily_limit");

    fetchSpy.mockRestore();
  });

  it("rejects listTransfers walletAddress when address is not owned by authenticated org", async () => {
    const res = await app.request(
      `/v1/payments/transfers?walletAddress=${TEST_SOLANA_ADDRESSES.wallet2}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("walletAddress");
  });

  it("returns NOT_FOUND when transfer signature does not involve any org wallet", async () => {
    const fetchSpy = mockRpcFetch(async (request) => {
      if (request.method === "getTransaction") {
        return jsonRpcResult(
          request.id,
          solTransferTx({
            slot: 123,
            blockTime: 1_735_920_000,
            source: TEST_SOLANA_ADDRESSES.wallet2,
            destination: TEST_SOLANA_ADDRESSES.wallet3,
            lamports: "500000000",
          })
        );
      }
      return jsonRpcResult(request.id, null);
    });

    const res = await app.request(
      "/v1/payments/transfers/sig_unowned_transfer",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");

    fetchSpy.mockRestore();
  });

  it("returns exact total after token and direction filters in listTransfers", async () => {
    const nowUnix = 1_735_920_000;

    const fetchSpy = mockRpcFetch(async (request) => {
      // biome-ignore lint/nursery/noSecrets: JSON-RPC method literal in test fixture.
      if (request.method === "getSignaturesForAddress") {
        const params = (request.params ?? []) as Array<{
          limit?: number;
          before?: string;
          commitment?: string;
        }>;
        const options = params[1];
        if (options?.before) {
          return jsonRpcResult(request.id, []);
        }

        return jsonRpcResult(request.id, [
          signatureRow({
            signature: "sig_sol_out",
            slot: 300,
            blockTime: nowUnix,
            confirmationStatus: "confirmed",
          }),
          signatureRow({
            signature: "sig_sol_in",
            slot: 299,
            blockTime: nowUnix - 10,
            confirmationStatus: "confirmed",
          }),
          signatureRow({
            signature: "sig_usdc_out",
            slot: 298,
            blockTime: nowUnix - 20,
            confirmationStatus: "confirmed",
          }),
        ]);
      }

      if (request.method === "getTransaction") {
        const signature = String(request.params?.[0] ?? "");
        if (signature === "sig_sol_out") {
          return jsonRpcResult(
            request.id,
            solTransferTx({
              slot: 300,
              blockTime: nowUnix,
              source: TEST_SOLANA_ADDRESSES.wallet1,
              destination: TEST_SOLANA_ADDRESSES.wallet2,
              lamports: "1000000000",
            })
          );
        }

        if (signature === "sig_sol_in") {
          return jsonRpcResult(
            request.id,
            solTransferTx({
              slot: 299,
              blockTime: nowUnix - 10,
              source: TEST_SOLANA_ADDRESSES.wallet2,
              destination: TEST_SOLANA_ADDRESSES.wallet1,
              lamports: "2000000000",
            })
          );
        }

        if (signature === "sig_usdc_out") {
          return jsonRpcResult(
            request.id,
            splTransferTx({
              slot: 298,
              blockTime: nowUnix - 20,
              source: TEST_SOLANA_ADDRESSES.wallet1,
              destination: TEST_SOLANA_ADDRESSES.wallet3,
              mint: TEST_SOLANA_ADDRESSES.mint,
              uiAmount: "5",
            })
          );
        }
      }

      return jsonRpcResult(request.id, null);
    });

    const query = new URLSearchParams({
      token: "SOL",
      direction: "outbound",
      page: "1",
      pageSize: "50",
    });
    const res = await app.request(
      `/v1/payments/transfers?${query.toString()}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; signature: string; token: string; direction: string }>;
      meta: { total: number };
    };
    expect(body.meta.total).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.id).toBe("sig_sol_out");
    expect(body.data[0]?.signature).toBe("sig_sol_out");
    expect(body.data[0]?.token).toBe("SOL");
    expect(body.data[0]?.direction).toBe("outbound");

    fetchSpy.mockRestore();
  });

  it("syncs finalized status into DB from listTransfers RPC history", async () => {
    const now = new Date().toISOString();
    const nowUnix = 1_735_920_100;

    await env.DB.prepare(
      `INSERT INTO payment_transfers
           (id, organization_id, project_id, wallet_id, source_address, destination_address, token, amount, memo, type, direction, status, signature, slot, block_time, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        "xfr_sync_finalized_list",
        TEST_ORG.id,
        null,
        TEST_WALLET_ID,
        TEST_SOLANA_ADDRESSES.wallet1,
        TEST_SOLANA_ADDRESSES.wallet2,
        "SOL",
        "1",
        null,
        "transfer",
        "outbound",
        "confirmed",
        "sig_sync_finalized_list",
        100,
        now,
        now,
        now
      )
      .run();

    const fetchSpy = mockRpcFetch(async (request) => {
      // biome-ignore lint/nursery/noSecrets: JSON-RPC method literal in test fixture.
      if (request.method === "getSignaturesForAddress") {
        const params = (request.params ?? []) as Array<{
          limit?: number;
          before?: string;
          commitment?: string;
        }>;
        const options = params[1];
        if (options?.before) {
          return jsonRpcResult(request.id, []);
        }

        return jsonRpcResult(request.id, [
          signatureRow({
            signature: "sig_sync_finalized_list",
            slot: 450,
            blockTime: nowUnix,
            confirmationStatus: "finalized",
          }),
        ]);
      }

      if (request.method === "getTransaction") {
        return jsonRpcResult(
          request.id,
          solTransferTx({
            slot: 450,
            blockTime: nowUnix,
            source: TEST_SOLANA_ADDRESSES.wallet1,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            lamports: "1000000000",
          })
        );
      }

      return jsonRpcResult(request.id, null);
    });

    const res = await app.request(
      `/v1/payments/transfers?wallet=${TEST_WALLET_ID}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ signature: string; status: string }>;
    };
    expect(body.data[0]?.signature).toBe("sig_sync_finalized_list");
    expect(body.data[0]?.status).toBe("finalized");

    const transfer = await env.DB.prepare("SELECT status, slot FROM payment_transfers WHERE id = ?")
      .bind("xfr_sync_finalized_list")
      .first<{ status: string; slot: number | null }>();
    expect(transfer?.status).toBe("finalized");
    expect(transfer?.slot).toBe(450);

    fetchSpy.mockRestore();
  });

  it("syncs finalized status into DB when reading an xfr_ transfer with a signature", async () => {
    const now = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO payment_transfers
           (id, organization_id, project_id, wallet_id, source_address, destination_address, token, amount, memo, type, direction, status, signature, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        "xfr_sync_finalized_get",
        TEST_ORG.id,
        null,
        TEST_WALLET_ID,
        TEST_SOLANA_ADDRESSES.wallet1,
        TEST_SOLANA_ADDRESSES.wallet2,
        "SOL",
        "1",
        null,
        "transfer",
        "outbound",
        "confirmed",
        "sig_sync_finalized_get",
        now,
        now
      )
      .run();

    const fetchSpy = mockRpcFetch(async (request) => {
      // biome-ignore lint/nursery/noSecrets: JSON-RPC method literal in test fixture.
      if (request.method === "getSignatureStatuses") {
        return jsonRpcResult(request.id, {
          context: { slot: 600 },
          value: [
            {
              slot: 600,
              err: null,
              confirmationStatus: "finalized",
            },
          ],
        });
      }
      return jsonRpcResult(request.id, null);
    });

    const res = await app.request(
      "/v1/payments/transfers/xfr_sync_finalized_get",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { transfer: { status: string } } };
    expect(body.data.transfer.status).toBe("finalized");

    const transfer = await env.DB.prepare("SELECT status, slot FROM payment_transfers WHERE id = ?")
      .bind("xfr_sync_finalized_get")
      .first<{ status: string; slot: number | null }>();
    expect(transfer?.status).toBe("finalized");
    expect(transfer?.slot).toBe(600);

    fetchSpy.mockRestore();
  });
});
