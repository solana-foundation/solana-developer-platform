import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const TEST_ORG = { id: "org_dvp_test", name: "DvP Test Org", slug: "dvp-test-org" };
const TEST_PROJECT = { id: "prj_dvp_test", slug: "dvp-test-project" };
const TEST_USER = { id: "usr_dvp_test", email: "dvp-test@example.com" };
const TEST_API_KEY = { id: "key_dvp_test", raw: "sk_test_dvp_routes", prefix: "sk_test_dvp" };

const TEST_CACHED_API_KEY: CachedApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

let originalMarkets: string | undefined;
let originalDvp: string | undefined;

async function seedAuth(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);
  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "enterprise", "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(TEST_USER.id, TEST_USER.email, 1, "active"),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_PROJECT.id,
        TEST_ORG.id,
        "Test Project",
        TEST_PROJECT.slug,
        "sandbox",
        "active",
        TEST_USER.id
      ),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        "DvP Test Key",
        TEST_API_KEY.prefix,
        keyHash,
        "api_admin",
        JSON.stringify(["*"]),
        "active"
      ),
  ]);
}

function authHeaders() {
  return {
    Authorization: `Bearer ${TEST_API_KEY.raw}`,
    "Content-Type": "application/json",
  };
}

const CUSTODY_CONFIG_ID = "cust_dvp_test";
/** `id` is the custody wallet record id the API takes; `walletId` is the provider's. */
const BOUND_WALLET = { id: "cwlt_dvp_test", walletId: "dvp_wallet_bound" };
const UNBOUND_WALLET = { id: "cwlt_dvp_other", walletId: "dvp_wallet_unbound" };

async function seedCustodyWallets(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'local', 'x', 'active')`
      )
      .bind(CUSTODY_CONFIG_ID, TEST_ORG.id, TEST_PROJECT.id),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, '5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn', 'active')`
      )
      .bind(BOUND_WALLET.id, CUSTODY_CONFIG_ID, BOUND_WALLET.walletId),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, '7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg', 'active')`
      )
      .bind(UNBOUND_WALLET.id, CUSTODY_CONFIG_ID, UNBOUND_WALLET.walletId),
  ]);
}

/**
 * Re-seeds the cached key as wallet-scoped, bound to one provider wallet.
 *
 * The binding row goes in the DATABASE as well as the cache, because the guard
 * deliberately re-reads it rather than trusting the request's auth context —
 * that context can be an hour-old KV snapshot.
 */
async function seedWalletScopedKey(walletId: string): Promise<void> {
  const db = getDb(env);
  await db
    .prepare(
      `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
       VALUES (?, ?, ?, ?)`
    )
    .bind(`akwp_dvp_${walletId}`, TEST_API_KEY.id, walletId, JSON.stringify(["*"]))
    .run();

  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, {
    ...TEST_CACHED_API_KEY,
    walletScope: "selected",
    signingWalletId: walletId,
    walletBindings: [
      {
        walletId,
        custodyWalletId: BOUND_WALLET.id,
        permissions: ["*"],
      },
    ],
  });
}

async function seedTradeFor(
  sdpWalletId: string,
  tradeId: string,
  observation?: { escrowAAmount: string; escrowAFrozen?: boolean }
): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO dvp_trades (
         id, organization_id, project_id, swap_dvp,
         settlement_authority, user_a, user_b, mint_a, mint_b, nonce,
         token_program_a, token_program_b,
         amount_a, amount_b, expiry_timestamp,
         user_a_settlement_destination, user_b_settlement_destination,
         escrow_a, escrow_b, sdp_side, sdp_wallet_id, status,
         escrow_a_amount, escrow_a_frozen
       ) VALUES (
         ?, ?, ?, 'BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po',
         '9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY',
         '5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn',
         '7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg',
         'ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1',
         'AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE',
         '42',
         'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
         'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
         '1000', '2000', '1800003600',
         '5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn',
         '7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg',
         'FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU',
         '6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y',
         'a', ?, 'created', ?, ?
       )`
    )
    .bind(
      tradeId,
      TEST_ORG.id,
      TEST_PROJECT.id,
      sdpWalletId,
      observation?.escrowAAmount ?? null,
      observation?.escrowAFrozen ?? null
    )
    .run();
}

/** A well-formed create body. Amounts are strings on purpose; see schemas.ts. */
function createBody(overrides: Record<string, unknown> = {}) {
  return {
    sdpWalletId: "cwlt_dvp_test",
    sdpSide: "a",
    counterparty: "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg",
    mintA: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
    tokenProgramA: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    mintB: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
    tokenProgramB: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    amountA: "1000",
    amountB: "2000",
    expiryTimestamp: String(Math.floor(Date.now() / 1000) + 3600),
    ...overrides,
  };
}

describe("DvP routes", () => {
  beforeEach(async () => {
    originalMarkets = env.MARKETS_ENABLED;
    originalDvp = env.DVP_ENABLED;
    env.MARKETS_ENABLED = "true";
    env.DVP_ENABLED = "true";
    await seedTestDatabase(env);
    await seedAuth();
  });

  afterEach(async () => {
    env.MARKETS_ENABLED = originalMarkets;
    env.DVP_ENABLED = originalDvp;
    await clearKVStores(env);
  });

  it("returns 403 when the DvP flag is off", async () => {
    env.DVP_ENABLED = undefined;
    const res = await app.request("/v1/dvp/trades", { headers: authHeaders() }, env);
    expect(res.status).toBe(403);
  });

  // DvP is a Markets sub-module, so clearing the parent has to dark-launch it
  // even with its own flag on. Same hierarchy Earn uses.
  it("returns 403 when Markets is off even though DvP is on", async () => {
    env.MARKETS_ENABLED = undefined;
    const res = await app.request("/v1/dvp/trades", { headers: authHeaders() }, env);
    expect(res.status).toBe(403);
  });

  it("requires authentication", async () => {
    const res = await app.request("/v1/dvp/trades", {}, env);
    expect(res.status).toBe(401);
  });

  // Every documented family answers in the { data, meta } envelope. DvP returned
  // a bare object, which would have made its OpenAPI registration a lie.
  it("lists no trades for a fresh project, in the standard envelope", async () => {
    const res = await app.request("/v1/dvp/trades", { headers: authHeaders() }, env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: unknown; meta: { timestamp: string } };
    expect(body.data).toEqual({ trades: [] });
    expect(body.meta.timestamp).toBeTruthy();
  });

  it("rejects a limit outside the documented range instead of clamping it", async () => {
    const res = await app.request("/v1/dvp/trades?limit=0", { headers: authHeaders() }, env);
    expect(res.status).toBe(400);
  });

  it("404s an unknown trade", async () => {
    const res = await app.request("/v1/dvp/trades/dvp_missing", { headers: authHeaders() }, env);
    expect(res.status).toBe(404);
  });

  // The schema takes u64s as strings. A JSON number rounds above 2^53, and for
  // the nonce that would publish an escrow address that does not match the
  // trade, so the surface refuses numbers outright rather than coercing them.
  it("rejects a numeric amount rather than coercing it", async () => {
    const res = await app.request(
      "/v1/dvp/trades",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(createBody({ amountA: 1000 })),
      },
      env
    );
    expect(res.status).toBe(400);
  });

  it("rejects a non-base58 counterparty", async () => {
    const res = await app.request(
      "/v1/dvp/trades",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(createBody({ counterparty: "not-an-address" })),
      },
      env
    );
    expect(res.status).toBe(400);
  });

  it("rejects a ref string longer than the program's 64-byte field", async () => {
    const res = await app.request(
      "/v1/dvp/trades",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(createBody({ refString: "x".repeat(65) })),
      },
      env
    );
    expect(res.status).toBe(400);
  });

  // The reconciler's observations are the whole point of the detail view, and
  // deriving `funded` per client would put the >= threshold in several places.
  describe("per-leg funding", () => {
    beforeEach(async () => {
      await seedCustodyWallets();
    });

    // Null is not zero. A brand-new trade shown as definitively unfunded would
    // be a claim nothing has actually checked.
    it("reports null funding before the reconciler has looked", async () => {
      await seedTradeFor(BOUND_WALLET.id, "dvp_unobserved");

      const res = await app.request(
        "/v1/dvp/trades/dvp_unobserved",
        { headers: authHeaders() },
        env
      );
      const body = (await res.json()) as { data: { trade: { legs: { a: { funding: unknown } } } } };

      expect(body.data.trade.legs.a.funding).toBeNull();
    });

    it("reports a leg short of its target as not funded", async () => {
      await seedTradeFor(BOUND_WALLET.id, "dvp_short", { escrowAAmount: "999" });

      const res = await app.request("/v1/dvp/trades/dvp_short", { headers: authHeaders() }, env);
      const body = (await res.json()) as {
        data: { trade: { legs: { a: { funding: { funded: boolean; surplus: string | null } } } } };
      };

      expect(body.data.trade.legs.a.funding.funded).toBe(false);
      expect(body.data.trade.legs.a.funding.surplus).toBeNull();
    });

    // The threshold is >=, matching what settle requires. An over-funded leg IS
    // funded — the surplus is refunded — so reporting it as unfunded would say
    // the trade is still waiting for money it already has.
    it("reports an over-funded leg as funded, and names the surplus", async () => {
      await seedTradeFor(BOUND_WALLET.id, "dvp_over", { escrowAAmount: "1500" });

      const res = await app.request("/v1/dvp/trades/dvp_over", { headers: authHeaders() }, env);
      const body = (await res.json()) as {
        data: { trade: { legs: { a: { funding: { funded: boolean; surplus: string } } } } };
      };

      expect(body.data.trade.legs.a.funding.funded).toBe(true);
      expect(body.data.trade.legs.a.funding.surplus).toBe("500");
    });

    it("surfaces a frozen escrow, which a zero balance cannot convey", async () => {
      await seedTradeFor(BOUND_WALLET.id, "dvp_frozen", {
        escrowAAmount: "0",
        escrowAFrozen: true,
      });

      const res = await app.request("/v1/dvp/trades/dvp_frozen", { headers: authHeaders() }, env);
      const body = (await res.json()) as {
        data: { trade: { legs: { a: { funding: { frozen: boolean } } } } };
      };

      expect(body.data.trade.legs.a.funding.frozen).toBe(true);
    });

    // u64 balances exceed 2^53. A float comparison would call a leg millions
    // short of its target fully funded.
    it("compares balances above 2^53 exactly", async () => {
      await seedTradeFor(BOUND_WALLET.id, "dvp_big", {
        escrowAAmount: "18446744073709551614",
      });

      const res = await app.request("/v1/dvp/trades/dvp_big", { headers: authHeaders() }, env);
      const body = (await res.json()) as {
        data: { trade: { legs: { a: { funding: { surplus: string } } } } };
      };

      // 18446744073709551614 - 1000
      expect(body.data.trade.legs.a.funding.surplus).toBe("18446744073709550614");
    });
  });

  // `payments:write` says the key may write. It does not say which wallet, and
  // the wallet named here pays the fee, pays the escrow rent and delivers SDP's
  // leg. Without this check a selected-wallet key could spend any custody wallet
  // in the project.
  describe("wallet scope", () => {
    beforeEach(async () => {
      await seedCustodyWallets();
    });

    it("refuses a custody wallet outside the key's bindings", async () => {
      await seedWalletScopedKey(BOUND_WALLET.walletId);

      const res = await app.request(
        "/v1/dvp/trades",
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(createBody({ sdpWalletId: UNBOUND_WALLET.id })),
        },
        env
      );

      expect(res.status).toBe(403);
    });

    // The complement. Without it, a guard that rejected everything would look
    // identical to a guard that works.
    it("admits the key's own bound wallet past the scope check", async () => {
      await seedWalletScopedKey(BOUND_WALLET.walletId);

      const res = await app.request(
        "/v1/dvp/trades",
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(createBody({ sdpWalletId: BOUND_WALLET.id })),
        },
        env
      );

      // Not 201: the request now runs on past the scope check into the mint
      // pre-flight, which reads chain state that route tests do not provide.
      // Asserting the error is not a FORBIDDEN is what proves the scope gate let
      // it through — a guard that rejected everything with some other status
      // would still satisfy a bare `not.toBe(403)`.
      expect(res.status).not.toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).not.toBe("FORBIDDEN");
    });

    it("hides another wallet's trades from a wallet-scoped key", async () => {
      await seedTradeFor(UNBOUND_WALLET.id, "dvp_unbound_trade");
      await seedWalletScopedKey(BOUND_WALLET.walletId);

      const list = await app.request("/v1/dvp/trades", { headers: authHeaders() }, env);
      const body = (await list.json()) as { data: { trades: { id: string }[] } };
      expect(body.data.trades).toEqual([]);

      const get = await app.request(
        "/v1/dvp/trades/dvp_unbound_trade",
        { headers: authHeaders() },
        env
      );
      // 404 rather than 403, so nothing leaks about which trades exist.
      expect(get.status).toBe(404);
    });

    it("shows the same trade to an unscoped key", async () => {
      await seedTradeFor(UNBOUND_WALLET.id, "dvp_unbound_trade");

      const list = await app.request("/v1/dvp/trades", { headers: authHeaders() }, env);
      const body = (await list.json()) as { data: { trades: { id: string }[] } };
      expect(body.data.trades.map((t) => t.id)).toEqual(["dvp_unbound_trade"]);
    });
  });
});
