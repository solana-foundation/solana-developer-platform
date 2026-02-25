import app from "@/index";
import { hashString } from "@/lib/hash";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/d1";
import { clearKVNamespaces, seedCachedApiKey } from "@/test/mocks/kv";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/solana/rpc", async () => {
  const actual =
    await vi.importActual<typeof import("@/services/solana/rpc")>("@/services/solana/rpc");
  return {
    ...actual,
    createRpc: vi.fn().mockReturnValue({}),
    getRecentBlockhash: vi.fn().mockResolvedValue({
      // biome-ignore lint/nursery/noSecrets: Test blockhash, not a secret.
      blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
      lastValidBlockHeight: 1000n,
    }),
    confirmTransaction: vi.fn().mockResolvedValue({
      signature:
        // biome-ignore lint/nursery/noSecrets: Test transaction signature, not a secret.
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy",
      slot: 100n,
      confirmationStatus: "confirmed",
      err: null,
    }),
  };
});

vi.mock("@/services/adapters/fee-payment", async () => {
  const actual = await vi.importActual<typeof import("@/services/adapters/fee-payment")>(
    "@/services/adapters/fee-payment"
  );
  return {
    ...actual,
    createFeePaymentAdapter: vi.fn().mockReturnValue({
      providerId: "mock",
      // biome-ignore lint/nursery/noSecrets: Test Solana address used as mock fee payer, not a secret.
      getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
      signAsFeePayer: vi.fn(),
      signAndSend: vi.fn().mockResolvedValue(
        // biome-ignore lint/nursery/noSecrets: Test transaction signature, not a secret.
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
      ),
    }),
  };
});

vi.mock("@/services/solana", async () => {
  const actual = await vi.importActual<typeof import("@/services/solana")>("@/services/solana");
  const { createNoopSigner } = await import("@solana/kit");
  return {
    ...actual,
    createOrgSigner: vi.fn().mockResolvedValue(
      // biome-ignore lint/nursery/noSecrets: Test Solana address, not a secret.
      createNoopSigner("8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ")
    ),
  };
});

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

describe("Payments routes", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedAuthAndWallet();
  });

  afterEach(async () => {
    await clearTestDatabase(env);
    await clearKVNamespaces(env);
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

  describe("prepare transfer — happy path", () => {
    it("creates a pending SOL transfer with no wallet policy", async () => {
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
            amount: "1",
          }),
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          transfer: { id: string; status: string };
          preparedTransaction: { serialized: string; blockhash: string };
        };
      };
      expect(body.data.transfer.status).toBe("pending");
      expect(body.data.transfer.id).toMatch(/^xfr_/);
      expect(body.data.preparedTransaction.serialized).toBeTruthy();
      expect(body.data.preparedTransaction.blockhash).toBe(
        // biome-ignore lint/nursery/noSecrets: Test blockhash, not a secret.
        "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"
      );

      const row = await env.DB.prepare(
        "SELECT status, serialized_tx FROM payment_transfers WHERE id = ?"
      )
        .bind(body.data.transfer.id)
        .first<{ status: string; serialized_tx: string | null }>();
      expect(row?.status).toBe("pending");
      expect(row?.serialized_tx).toBeTruthy();
    });

    it("creates a pending SOL transfer when destination is on the allowlist", async () => {
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
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: "SOL",
            amount: "1",
          }),
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          transfer: { id: string; status: string };
          preparedTransaction: { serialized: string };
        };
      };
      expect(body.data.transfer.status).toBe("pending");
      expect(body.data.transfer.id).toMatch(/^xfr_/);
      expect(body.data.preparedTransaction.serialized).toBeTruthy();
    });

    it("returns 400 when required field amount is missing", async () => {
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
            // amount omitted
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("BAD_REQUEST");

      const transfers = await env.DB.prepare("SELECT id FROM payment_transfers").all<{
        id: string;
      }>();
      expect(transfers.results).toHaveLength(0);
    });

    it("returns 400 when destination address is too short", async () => {
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
            destination: "bad",
            token: "SOL",
            amount: "1",
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("BAD_REQUEST");
    });

    it("returns 404 when source wallet does not exist", async () => {
      const res = await app.request(
        "/v1/payments/transfers/prepare",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            source: "wal_nonexistent_wallet",
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: "SOL",
            amount: "1",
          }),
        },
        env
      );

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_FOUND");

      const transfers = await env.DB.prepare("SELECT id FROM payment_transfers").all<{
        id: string;
      }>();
      expect(transfers.results).toHaveLength(0);
    });
  });

  it("blocks create transfer when projected daily total exceeds maxDailyAmount", async () => {
    await seedWalletPolicy({
      destinationAllowlist: [],
      maxDailyAmount: "2.0",
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
        "confirmed",
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
  });

  describe("execute transfer — happy path", () => {
    it("executes a SOL transfer and returns a confirmed transfer record", async () => {
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
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: "SOL",
            amount: "1",
          }),
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          transfer: { id: string; status: string; signature: string | null };
        };
      };
      expect(body.data.transfer.status).toBe("confirmed");
      expect(body.data.transfer.id).toMatch(/^xfr_/);
      expect(body.data.transfer.signature).toBeTruthy();

      const row = await env.DB.prepare(
        "SELECT status, signature FROM payment_transfers WHERE id = ?"
      )
        .bind(body.data.transfer.id)
        .first<{ status: string; signature: string | null }>();
      expect(row?.status).toBe("confirmed");
      expect(row?.signature).toBeTruthy();
    });

    it("marks the transfer as failed when execution throws and returns 502", async () => {
      const { createFeePaymentAdapter } = await import("@/services/adapters/fee-payment");
      vi.mocked(createFeePaymentAdapter).mockReturnValueOnce({
        providerId: "mock",
        // biome-ignore lint/nursery/noSecrets: Test Solana address used as mock fee payer, not a secret.
        getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
        signAsFeePayer: vi.fn(),
        signAndSend: vi.fn().mockRejectedValue(new Error("RPC connection refused")),
      });

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
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: "SOL",
            amount: "1",
          }),
        },
        env
      );

      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("SOLANA_RPC_ERROR");

      const transfers = await env.DB.prepare("SELECT status, error FROM payment_transfers").all<{
        status: string;
        error: string | null;
      }>();
      expect(transfers.results).toHaveLength(1);
      expect(transfers.results[0]?.status).toBe("failed");
      expect(transfers.results[0]?.error).toBeTruthy();
    });
  });
});
