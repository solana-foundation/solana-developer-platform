import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createPostgresCounterpartiesRepository } from "@/db/repositories/counterparty.repository.postgres";
import { createPostgresCounterpartyAccountsRepository } from "@/db/repositories/counterparty-account.repository.postgres";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";
import { deriveDvpTradeKind } from "./dvp/handlers";

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

// The cross-org party that reads a trade it did not create. Its whole reason
// to exist is that attribution and funding claims do NOT cross to it.
const PARTY_ORG = { id: "org_dvp_party", name: "DvP Party Org", slug: "dvp-party-org" };
const PARTY_PROJECT = { id: "prj_dvp_party", slug: "dvp-party-project" };
const PARTY_API_KEY = {
  id: "key_dvp_party",
  raw: "sk_test_dvp_party_routes",
  prefix: "sk_test_dvp_party",
};

const PARTY_CACHED_API_KEY: CachedApiKey = {
  id: PARTY_API_KEY.id,
  organizationId: PARTY_ORG.id,
  projectId: PARTY_PROJECT.id,
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

/**
 * Seeds the second organization a trade can be read by as a PARTY: it holds a
 * custody wallet whose public key is one of the party addresses, which is the
 * whole contract of the 0089 read and the custody-lookup authorization.
 */
async function seedPartyOrg(): Promise<void> {
  const keyHash = await hashString(PARTY_API_KEY.raw, env.API_KEY_PEPPER);
  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(PARTY_ORG.id, PARTY_ORG.name, PARTY_ORG.slug, "enterprise", "active"),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        PARTY_PROJECT.id,
        PARTY_ORG.id,
        "Party Project",
        PARTY_PROJECT.slug,
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
        PARTY_API_KEY.id,
        PARTY_ORG.id,
        PARTY_PROJECT.id,
        TEST_USER.id,
        "DvP Party Key",
        PARTY_API_KEY.prefix,
        keyHash,
        "api_admin",
        JSON.stringify(["*"]),
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'local', 'x', 'active')`
      )
      .bind("cust_dvp_party", PARTY_ORG.id, PARTY_PROJECT.id),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind("cwlt_dvp_party", "cust_dvp_party", "dvp_party_wallet", PARTY_A_ADDRESS),
  ]);
  await seedCachedApiKey(env, keyHash, PARTY_CACHED_API_KEY);
}

function partyAuthHeaders() {
  return {
    Authorization: `Bearer ${PARTY_API_KEY.raw}`,
    "Content-Type": "application/json",
  };
}

const CUSTODY_CONFIG_ID = "cust_dvp_test";

// Party addresses on every seeded trade. Side A is an address the CREATOR's
// (and the party org's) custody wallet holds; side B is a pure external
// address nobody in either test org holds.
const PARTY_A_ADDRESS = "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn";
const PARTY_B_EXTERNAL = "C8gNHiN7huZr5g6foxuPZqPh2kbQHiGQUDkhcnL7CFzk";
// An address held by NEITHER party of the seeded trades, so a key bound to
// this wallet can prove an unrelated binding sees nothing.
const THIRD_ADDRESS = "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC";
const UNRELATED_ADDRESS = "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU";

/** `id` is the custody wallet record id the API takes; `walletId` is the provider's. */
const BOUND_WALLET = { id: "cwlt_dvp_test", walletId: "dvp_wallet_bound" };
const UNBOUND_WALLET = { id: "cwlt_dvp_other", walletId: "dvp_wallet_unbound" };
const THIRD_WALLET = { id: "cwlt_dvp_third", walletId: "dvp_wallet_third" };

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
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(BOUND_WALLET.id, CUSTODY_CONFIG_ID, BOUND_WALLET.walletId, PARTY_A_ADDRESS),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(UNBOUND_WALLET.id, CUSTODY_CONFIG_ID, UNBOUND_WALLET.walletId, THIRD_ADDRESS),
    // A wallet whose address is neither party of the seeded trades, so
    // key-scope tests can prove an unrelated binding sees nothing (and so its
    // presence in the org never flips a party's `custodied`).
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(THIRD_WALLET.id, CUSTODY_CONFIG_ID, THIRD_WALLET.walletId, UNRELATED_ADDRESS),
  ]);
}

/**
 * Re-seeds the cached key as wallet-scoped, bound to one custody wallet.
 *
 * The binding row goes in the DATABASE as well as the cache, because the guard
 * deliberately re-reads it rather than trusting the request's auth context —
 * that context can be an hour-old KV snapshot.
 */
async function seedWalletScopedKey(wallet: { id: string; walletId: string }): Promise<void> {
  const db = getDb(env);
  await db
    .prepare(
      `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
       VALUES (?, ?, ?, ?)`
    )
    .bind(`akwp_dvp_${wallet.id}`, TEST_API_KEY.id, wallet.walletId, JSON.stringify(["*"]))
    .run();

  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, {
    ...TEST_CACHED_API_KEY,
    walletScope: "selected",
    signingWalletId: wallet.walletId,
    walletBindings: [
      {
        walletId: wallet.walletId,
        custodyWalletId: wallet.id,
        permissions: ["*"],
      },
    ],
  });
}

/**
 * Seeds a trade row directly, so a route test can assert read behavior
 * without the chain work create performs. Defaults: side A is the creator's
 * custody wallet address, side B is an external address nobody holds.
 */
async function seedTradeFor(params: {
  tradeId: string;
  /** The on-chain trade account. Unique per row, so a list test can seed several. */
  swapDvp?: string;
  userA?: string;
  userB?: string;
  counterpartyAccountIdA?: string | null;
  counterpartyAccountIdB?: string | null;
  observation?: { escrowAAmount: string; escrowAFrozen?: boolean };
}): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO dvp_trades (
         id, organization_id, project_id, swap_dvp,
         settlement_authority, user_a, user_b, mint_a, mint_b, nonce,
         token_program_a, token_program_b,
         amount_a, amount_b, expiry_timestamp,
         user_a_settlement_destination, user_b_settlement_destination,
         escrow_a, escrow_b,
         counterparty_account_id_a, counterparty_account_id_b,
         status, escrow_a_amount, escrow_a_frozen
       ) VALUES (
         ?, ?, ?, ?,
         '9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY',
         ?, ?,
         'ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1',
         'AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE',
         '42',
         'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
         'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
         '1000', '2000', '1800003600',
         ?, ?,
         'FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU',
         '6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y',
         ?, ?,
         'created', ?, ?
       )`
    )
    .bind(
      params.tradeId,
      TEST_ORG.id,
      TEST_PROJECT.id,
      params.swapDvp ?? "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po",
      params.userA ?? PARTY_A_ADDRESS,
      params.userB ?? PARTY_B_EXTERNAL,
      params.userA ?? PARTY_A_ADDRESS,
      params.userB ?? PARTY_B_EXTERNAL,
      params.counterpartyAccountIdA ?? null,
      params.counterpartyAccountIdB ?? null,
      params.observation?.escrowAAmount ?? null,
      params.observation?.escrowAFrozen ?? null
    )
    .run();
}

/** A funding claim row, as `fundDvpTradeLeg` would leave it. */
async function seedClaim(
  tradeId: string,
  side: "a" | "b",
  signature: string,
  fundingTx: string | null = null
): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO dvp_leg_funding_claims
         (trade_id, side, organization_id, project_id, custody_wallet_id, signature, expiry_height, funding_tx)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      tradeId,
      side,
      TEST_ORG.id,
      TEST_PROJECT.id,
      BOUND_WALLET.id,
      signature,
      "999999",
      fundingTx
    )
    .run();
}

/**
 * A registered counterparty with a crypto-wallet account, so trades can carry
 * the attribution the creator's own view must render as ``{id, label}``.
 */
async function seedCounterpartyForParty(
  partyAddress: string
): Promise<{ counterpartyId: string; accountId: string }> {
  const counterparty = await createPostgresCounterpartiesRepository(getDb(env)).createCounterparty({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    externalId: `ext_dvp_${partyAddress}`,
    entityType: "business",
    displayName: "Acme Desk",
    providerData: {},
    createdBy: TEST_USER.id,
  });
  if (counterparty === null) {
    throw new Error("failed to seed counterparty");
  }
  const account = await createPostgresCounterpartyAccountsRepository(
    getDb(env)
  ).createCounterpartyAccount({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    counterpartyId: counterparty.id,
    accountKind: "crypto_wallet",
    details: { network: "solana", address: partyAddress },
  });
  if (account === null) {
    throw new Error("failed to seed counterparty account");
  }
  return { counterpartyId: counterparty.id, accountId: account.id };
}

/** The seeded row's own timestamps, so a full-shape assertion stays exact. */
async function readTradeTimestamps(
  tradeId: string
): Promise<{ createdAt: string; updatedAt: string }> {
  const row = await getDb(env)
    .prepare("SELECT created_at, updated_at FROM dvp_trades WHERE id = ?")
    .bind(tradeId)
    .first<{ created_at: string; updated_at: string }>();
  if (row === undefined || row === null) {
    throw new Error(`seeded trade ${tradeId} not found`);
  }
  return { createdAt: row.created_at, updatedAt: row.updated_at };
}

async function fundingClaimCount(tradeId: string): Promise<number> {
  const row = await getDb(env)
    .prepare("SELECT COUNT(*)::int AS n FROM dvp_leg_funding_claims WHERE trade_id = ?")
    .bind(tradeId)
    .first<{ n: number }>();
  return row === undefined || row === null ? 0 : row.n;
}

/** A well-formed create body. Amounts are strings on purpose; see schemas.ts. */
function createBody(overrides: Record<string, unknown> = {}) {
  return {
    partyA: { walletId: "cwlt_dvp_test" },
    partyB: { address: PARTY_B_EXTERNAL },
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

describe("deriveDvpTradeKind", () => {
  it("derives agent when no side is the caller's", () => {
    expect(deriveDvpTradeKind(new Map(), PARTY_A_ADDRESS, PARTY_B_EXTERNAL)).toBe("agent");
  });

  it("derives principal when one side is the caller's", () => {
    const caller = new Map([[PARTY_A_ADDRESS, BOUND_WALLET.id]]);
    expect(deriveDvpTradeKind(caller, PARTY_A_ADDRESS, PARTY_B_EXTERNAL)).toBe("principal");
  });

  it("derives bilateral when both sides are the caller's", () => {
    const caller = new Map([
      [PARTY_A_ADDRESS, BOUND_WALLET.id],
      [PARTY_B_EXTERNAL, UNBOUND_WALLET.id],
    ]);
    expect(deriveDvpTradeKind(caller, PARTY_A_ADDRESS, PARTY_B_EXTERNAL)).toBe("bilateral");
  });
});

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

  it("rejects a non-base58 party address", async () => {
    const res = await app.request(
      "/v1/dvp/trades",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(createBody({ partyB: { address: "not-an-address" } })),
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
      await seedTradeFor({ tradeId: "dvp_unobserved" });

      const res = await app.request(
        "/v1/dvp/trades/dvp_unobserved",
        { headers: authHeaders() },
        env
      );
      const body = (await res.json()) as { data: { trade: { legs: { a: { funding: unknown } } } } };

      expect(body.data.trade.legs.a.funding).toBeNull();
    });

    it("reports a leg short of its target as not funded", async () => {
      await seedTradeFor({ tradeId: "dvp_short", observation: { escrowAAmount: "999" } });

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
      await seedTradeFor({ tradeId: "dvp_over", observation: { escrowAAmount: "1500" } });

      const res = await app.request("/v1/dvp/trades/dvp_over", { headers: authHeaders() }, env);
      const body = (await res.json()) as {
        data: { trade: { legs: { a: { funding: { funded: boolean; surplus: string } } } } };
      };

      expect(body.data.trade.legs.a.funding.funded).toBe(true);
      expect(body.data.trade.legs.a.funding.surplus).toBe("500");
    });

    it("surfaces a frozen escrow, which a zero balance cannot convey", async () => {
      await seedTradeFor({
        tradeId: "dvp_frozen",
        observation: { escrowAAmount: "0", escrowAFrozen: true },
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
      await seedTradeFor({
        tradeId: "dvp_big",
        observation: { escrowAAmount: "18446744073709551614" },
      });

      const res = await app.request("/v1/dvp/trades/dvp_big", { headers: authHeaders() }, env);
      const body = (await res.json()) as {
        data: { trade: { legs: { a: { funding: { surplus: string } } } } };
      };

      // 18446744073709551614 - 1000
      expect(body.data.trade.legs.a.funding.surplus).toBe("18446744073709550614");
    });
  });

  describe("per-leg fundingSignature", () => {
    beforeEach(async () => {
      await seedCustodyWallets();
    });

    // The receipt first, the live claim while a funding is still in flight:
    // a claim alone would link the leg only for the minute the claim lived.
    it("prefers the funding receipt over a still-live claim", async () => {
      await seedTradeFor({ tradeId: "dvp_funded_leg" });
      await seedClaim("dvp_funded_leg", "a", "sig_live_claim", "sig_funding_receipt");

      const res = await app.request(
        "/v1/dvp/trades/dvp_funded_leg",
        { headers: authHeaders() },
        env
      );
      const body = (await res.json()) as {
        data: { trade: { legs: { a: { fundingSignature: string } } } };
      };

      expect(body.data.trade.legs.a.fundingSignature).toBe("sig_funding_receipt");
    });

    // The fallback exists so an in-flight funding links to the transaction it
    // is waiting on, rather than showing a funded leg with no transaction at
    // all until the sweep confirms the transfer.
    it("falls back to the live claim signature while the funding is in flight", async () => {
      await seedTradeFor({ tradeId: "dvp_inflight_leg" });
      await seedClaim("dvp_inflight_leg", "a", "sig_live_claim");

      const res = await app.request(
        "/v1/dvp/trades/dvp_inflight_leg",
        { headers: authHeaders() },
        env
      );
      const body = (await res.json()) as {
        data: { trade: { legs: { a: { fundingSignature: string } } } };
      };

      expect(body.data.trade.legs.a.fundingSignature).toBe("sig_live_claim");
    });

    // A leg with no claim at all has no transaction to show. Null, not a made
    // up value — the two are the same answer to "what funded this leg".
    it("reports null for a leg with no claim", async () => {
      await seedTradeFor({ tradeId: "dvp_unclaimed_leg" });

      const res = await app.request(
        "/v1/dvp/trades/dvp_unclaimed_leg",
        { headers: authHeaders() },
        env
      );
      const body = (await res.json()) as {
        data: { trade: { legs: { a: { fundingSignature: string | null } } } };
      };

      expect(body.data.trade.legs.a.fundingSignature).toBeNull();
    });
  });

  // Funding authorization is the custody lookup: the caller must hold an
  // active custody wallet whose public key is the named side's party address,
  // re-read from the database before anything is signed or written.
  describe("fund refusal without custody", () => {
    beforeEach(async () => {
      await seedCustodyWallets();
    });

    it("refuses a side whose party address matches no caller wallet, writing no claim", async () => {
      await seedTradeFor({ tradeId: "dvp_no_custody", userA: PARTY_B_EXTERNAL });

      const res = await app.request(
        "/v1/dvp/trades/dvp_no_custody/fund",
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ side: "a" }),
        },
        env
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("FORBIDDEN");
      // The refusal happened before any bytes went out: no claim row exists.
      expect(await fundingClaimCount("dvp_no_custody")).toBe(0);
    });

    it("refuses an explicit wallet that does not hold the named side's party address, writing no claim", async () => {
      // Side A is the BOUND wallet's address; naming that wallet for side B,
      // which is an external address, must narrow rather than widen.
      await seedTradeFor({ tradeId: "dvp_wrong_wallet" });

      const res = await app.request(
        "/v1/dvp/trades/dvp_wrong_wallet/fund",
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ side: "b", walletId: BOUND_WALLET.id }),
        },
        env
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("FORBIDDEN");
      expect(await fundingClaimCount("dvp_wrong_wallet")).toBe(0);
    });
  });

  // A response never states ownership — it derives it for the caller. The
  // full-shape assertions below are the field-additions projection sweep:
  // checking spot fields would let an added field pass silently, so the whole
  // trade object is compared.
  describe("derived party objects and kind", () => {
    beforeEach(async () => {
      await seedCustodyWallets();
    });

    it("answers the creator's view: custodied side, counterparty label, live-claim signature", async () => {
      const { accountId } = await seedCounterpartyForParty(PARTY_A_ADDRESS);
      await seedTradeFor({
        tradeId: "dvp_full",
        counterpartyAccountIdA: accountId,
        observation: { escrowAAmount: "1000" },
      });
      await seedClaim("dvp_full", "a", "sig_live_claim");
      const { createdAt, updatedAt } = await readTradeTimestamps("dvp_full");

      const res = await app.request("/v1/dvp/trades/dvp_full", { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { data: { trade: unknown } };
      expect(body.data.trade).toEqual({
        id: "dvp_full",
        status: "created",
        swapDvp: "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po",
        settlementAuthority: "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY",
        legs: {
          a: {
            party: {
              address: PARTY_A_ADDRESS,
              counterparty: { id: accountId, label: "Acme Desk" },
              custodied: true,
            },
            mint: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
            tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
            amount: "1000",
            decimals: null,
            symbol: null,
            escrow: "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU",
            settlementDestination: PARTY_A_ADDRESS,
            funding: {
              observedAmount: "1000",
              funded: true,
              surplus: null,
              frozen: false,
            },
            fundingSignature: "sig_live_claim",
          },
          b: {
            party: {
              address: PARTY_B_EXTERNAL,
              counterparty: null,
              custodied: false,
            },
            mint: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
            tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
            amount: "2000",
            decimals: null,
            symbol: null,
            escrow: "6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y",
            settlementDestination: PARTY_B_EXTERNAL,
            funding: null,
            fundingSignature: null,
          },
        },
        kind: "principal",
        nonce: "42",
        expiryTimestamp: "1800003600",
        earliestSettlementTimestamp: null,
        refString: null,
        createSignature: null,
        closeSignature: null,
        observedAt: null,
        createdAt,
        updatedAt,
        settlementReadiness: null,
      });
    });

    it("answers a cross-org party's view: no attribution, custodied for their side, kind from their wallets", async () => {
      // The row CARRIES the counterparty link; the party org must still see
      // null for it, because attribution is the creator org's fact.
      //
      // No claims are seeded: funding claims are tenant-scoped to the funding
      // org, and the local test role bypasses RLS, so an HTTP-level assertion
      // of cross-org claim HIDING would bake the bypass artifact in. The
      // boundary itself is covered by db-level policy tests.
      const { accountId } = await seedCounterpartyForParty(PARTY_A_ADDRESS);
      await seedTradeFor({ tradeId: "dvp_party_view", counterpartyAccountIdA: accountId });
      await seedPartyOrg();
      const { createdAt, updatedAt } = await readTradeTimestamps("dvp_party_view");

      const res = await app.request(
        "/v1/dvp/trades/dvp_party_view",
        { headers: partyAuthHeaders() },
        env
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as { data: { trade: unknown } };
      expect(body.data.trade).toEqual({
        id: "dvp_party_view",
        status: "created",
        swapDvp: "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po",
        settlementAuthority: "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY",
        legs: {
          a: {
            party: {
              address: PARTY_A_ADDRESS,
              counterparty: null,
              custodied: true,
            },
            mint: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
            tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
            amount: "1000",
            decimals: null,
            symbol: null,
            escrow: "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU",
            settlementDestination: PARTY_A_ADDRESS,
            funding: null,
            fundingSignature: null,
          },
          b: {
            party: {
              address: PARTY_B_EXTERNAL,
              counterparty: null,
              custodied: false,
            },
            mint: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
            tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
            amount: "2000",
            decimals: null,
            symbol: null,
            escrow: "6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y",
            settlementDestination: PARTY_B_EXTERNAL,
            funding: null,
            fundingSignature: null,
          },
        },
        kind: "principal",
        nonce: "42",
        expiryTimestamp: "1800003600",
        earliestSettlementTimestamp: null,
        refString: null,
        createSignature: null,
        closeSignature: null,
        observedAt: null,
        createdAt,
        updatedAt,
        yourSide: "a",
        settlementReadiness: null,
      });
    });

    it("lists the same derived shapes, one page at a time", async () => {
      const { accountId } = await seedCounterpartyForParty(PARTY_A_ADDRESS);
      await seedTradeFor({
        tradeId: "dvp_list_1",
        swapDvp: "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg",
        counterpartyAccountIdA: accountId,
      });
      await seedTradeFor({ tradeId: "dvp_list_2", userB: PARTY_A_ADDRESS });

      const res = await app.request("/v1/dvp/trades", { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        data: {
          trades: {
            id: string;
            kind: string;
            legs: {
              a: { party: { custodied: boolean; counterparty: unknown } };
              b: { party: { custodied: boolean } };
            };
          }[];
        };
      };
      const first = body.data.trades.find((trade) => trade.id === "dvp_list_1");
      const second = body.data.trades.find((trade) => trade.id === "dvp_list_2");
      if (first === undefined || second === undefined) {
        throw new Error("seeded list trades missing from the response");
      }
      expect(first.kind).toBe("principal");
      expect(first.legs.a.party.custodied).toBe(true);
      expect(first.legs.a.party.counterparty).toEqual({
        id: accountId,
        label: "Acme Desk",
      });
      // Both sides held by the creator's wallets: bilateral.
      expect(second.kind).toBe("bilateral");
      expect(second.legs.a.party.custodied).toBe(true);
      expect(second.legs.b.party.custodied).toBe(true);
    });
  });

  describe("inbound", () => {
    beforeEach(async () => {
      await seedCustodyWallets();
    });

    it("tells the party which leg is theirs, with derived party objects and no attribution", async () => {
      await seedTradeFor({ tradeId: "dvp_inbound_seen" });
      await seedPartyOrg();

      const res = await app.request("/v1/dvp/trades/inbound", { headers: partyAuthHeaders() }, env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        data: {
          trades: {
            id: string;
            yourSide: string;
            kind?: unknown;
            legs: {
              a: {
                party: { address: string; counterparty: unknown; custodied: boolean };
                fundingSignature?: unknown;
              };
              b: { party: { address: string; counterparty: unknown; custodied: boolean } };
            };
          }[];
        };
      };
      expect(body.data.trades).toHaveLength(1);
      const trade = body.data.trades[0];
      if (trade === undefined) {
        throw new Error("inbound trade missing from the response");
      }
      expect(trade.id).toBe("dvp_inbound_seen");
      expect(trade.yourSide).toBe("a");
      expect(trade.legs.a.party).toEqual({
        address: PARTY_A_ADDRESS,
        counterparty: null,
        custodied: true,
      });
      expect(trade.legs.b.party).toEqual({
        address: PARTY_B_EXTERNAL,
        counterparty: null,
        custodied: false,
      });
      // The inbound shape carries neither the creator's derived kind nor the
      // funding claims — both belong to organizations that can read the row.
      expect(trade.kind).toBeUndefined();
      expect(trade.legs.a.fundingSignature).toBeUndefined();
    });
  });

  describe("wallet scope", () => {
    beforeEach(async () => {
      await seedCustodyWallets();
    });

    it("shows a trade the bound wallet is a party to, in list and get", async () => {
      await seedWalletScopedKey(BOUND_WALLET);
      await seedTradeFor({ tradeId: "dvp_bound_party" });

      const list = await app.request("/v1/dvp/trades", { headers: authHeaders() }, env);
      const listBody = (await list.json()) as { data: { trades: { id: string }[] } };
      expect(listBody.data.trades.map((trade) => trade.id)).toEqual(["dvp_bound_party"]);

      const get = await app.request(
        "/v1/dvp/trades/dvp_bound_party",
        { headers: authHeaders() },
        env
      );
      expect(get.status).toBe(200);
      const getBody = (await get.json()) as {
        data: {
          trade: {
            kind: string;
            legs: { a: { party: { custodied: boolean } }; b: { party: { custodied: boolean } } };
          };
        };
      };
      // The scoped key's view derives from ITS OWN bindings: side A (its
      // address) custodied, side B not, kind principal.
      expect(getBody.data.trade.legs.a.party.custodied).toBe(true);
      expect(getBody.data.trade.legs.b.party.custodied).toBe(false);
      expect(getBody.data.trade.kind).toBe("principal");
    });

    it("hides a trade the bound wallet is not party to: absent from list, 404 on get, row untouched", async () => {
      await seedWalletScopedKey(THIRD_WALLET);
      await seedTradeFor({ tradeId: "dvp_unrelated_trade" });

      const list = await app.request("/v1/dvp/trades", { headers: authHeaders() }, env);
      const listBody = (await list.json()) as { data: { trades: { id: string }[] } };
      expect(listBody.data.trades).toEqual([]);

      const get = await app.request(
        "/v1/dvp/trades/dvp_unrelated_trade",
        { headers: authHeaders() },
        env
      );
      // 404 rather than 403, so nothing leaks about which trades exist.
      expect(get.status).toBe(404);

      // The reads must not have touched the row.
      const row = await getDb(env)
        .prepare("SELECT status, escrow_a_amount FROM dvp_trades WHERE id = ?")
        .bind("dvp_unrelated_trade")
        .first<{ status: string; escrow_a_amount: string | null }>();
      expect(row).toEqual({ status: "created", escrow_a_amount: null });
    });

    it("shows the same trade to an unscoped key", async () => {
      await seedTradeFor({ tradeId: "dvp_unbound_trade" });

      const list = await app.request("/v1/dvp/trades", { headers: authHeaders() }, env);
      const body = (await list.json()) as { data: { trades: { id: string }[] } };
      expect(body.data.trades.map((trade) => trade.id)).toEqual(["dvp_unbound_trade"]);
    });
  });

  // `payments:write` says the key may write. It does not say which wallet, and
  // a wallet named in a create either pays the fee and rent (the payer) or is
  // staged for funding (a party slot). Without this check a selected-wallet
  // key could spend any custody wallet in the project.
  describe("create wallet scope", () => {
    beforeEach(async () => {
      await seedCustodyWallets();
    });

    it("refuses a custody wallet outside the key's bindings", async () => {
      await seedWalletScopedKey(BOUND_WALLET);

      const res = await app.request(
        "/v1/dvp/trades",
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(createBody({ partyA: { walletId: UNBOUND_WALLET.id } })),
        },
        env
      );

      expect(res.status).toBe(403);
    });

    // The complement. Without it, a guard that rejected everything would look
    // identical to a guard that works.
    it("admits the key's own bound wallet past the scope check", async () => {
      await seedWalletScopedKey(BOUND_WALLET);

      const res = await app.request(
        "/v1/dvp/trades",
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(createBody({ partyA: { walletId: BOUND_WALLET.id } })),
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
  });
});
