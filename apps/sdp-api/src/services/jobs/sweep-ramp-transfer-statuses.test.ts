import type { PaymentTransferStatus } from "@sdp/types/payments";
import { SOL_MINT, wellKnownMint } from "@sdp/types/well-known-tokens";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import type { ManagedRampKeysEnv } from "@/services/ramps/runtime";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { installStripeTestEnv } from "@/test/helpers/stripe-env";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  RAMP_STATUS_PULLS_PER_SWEEP,
  type RampStatusSweepResult,
  sweepRampTransferStatuses,
} from "./sweep-ramp-transfer-statuses";

const ORG = "org_ramp_status_sweep";
const USER = "usr_ramp_status_sweep";
const PROJECTS = { sandbox: "prj_ramp_status_sandbox", production: "prj_ramp_status_production" };
const MOONPAY_TEST_ENV = {
  MOONPAY_SANDBOX_API_KEY: "pk_test_status_sweep",
  MOONPAY_SANDBOX_SECRET_KEY: "sk_test_status_sweep",
} satisfies ManagedRampKeysEnv;
const MOONPAY_PRODUCTION_ENV = {
  MOONPAY_PRODUCTION_API_KEY: "pk_live_status_sweep",
  MOONPAY_PRODUCTION_SECRET_KEY: "sk_live_status_sweep",
} satisfies ManagedRampKeysEnv;
const SIG =
  "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy";
const WALLET = "8mSiNWTeu59yy1pxsoNCyy7KNMnKvfgGu8Ej975LsufM";
const usdcMint = wellKnownMint("USDC", "devnet");
if (!usdcMint) throw new Error("USDC devnet mint missing");
const USDC: string = usdcMint;

/** Well past every abandonment horizon. */
const LONG_AGO = "2026-10-01T00:00:00.000Z";

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

interface SeedTransfer {
  id: string;
  provider: "moonpay" | "stripe";
  type?: "onramp" | "offramp";
  status?: PaymentTransferStatus;
  reference?: string | null;
  observedAt?: string | null;
  updatedAt?: string;
  createdAt?: string;
  project?: string;
  token?: string;
  providerData?: Record<string, unknown>;
}

async function seedTransfer(input: SeedTransfer): Promise<void> {
  const type = input.type ?? "onramp";
  const updatedAt = input.updatedAt ?? LONG_AGO;
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers
       (id, organization_id, project_id, wallet_id, source_address, destination_address,
        token, amount, type, direction, status, provider, provider_reference, provider_observed_at,
        delivery_mode, fiat_currency, fiat_amount, provider_data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', '10', ?::jsonb, ?, ?)`
    )
    .bind(
      input.id,
      ORG,
      input.project ?? PROJECTS.sandbox,
      "wallet_ramp_status_sweep",
      type === "offramp" ? WALLET : null,
      type === "onramp" ? WALLET : null,
      input.token ?? (input.provider === "stripe" ? USDC : SOL_MINT),
      type === "offramp" ? "1" : null,
      type,
      type === "onramp" ? "inbound" : "outbound",
      input.status ?? "pending",
      input.provider,
      input.reference ?? null,
      input.observedAt ?? null,
      input.provider === "stripe" ? "session_widget" : "hosted",
      input.providerData ?? {},
      input.createdAt ?? updatedAt,
      updatedAt
    )
    .run();
}

async function row(id: string) {
  const found = await getDb(env)
    .prepare(
      `SELECT status, signature, provider_reference, provider_data, updated_at,
              provider_status_last_polled_at
       FROM payment_transfers WHERE id = ?`
    )
    .bind(id)
    .first<{
      status: PaymentTransferStatus;
      signature: string | null;
      provider_reference: string | null;
      provider_data: Record<string, unknown>;
      updated_at: string;
      provider_status_last_polled_at: string | null;
    }>();
  if (!found) throw new Error(`transfer ${id} missing`);
  return found;
}

/** Provider answers by request path; anything unanswered is a 404, as an unknown id is. */
type ProviderBody = Record<string, unknown> | readonly Record<string, unknown>[];
let answers = new Map<string, { status: number; body: ProviderBody }>();
let requests: string[] = [];

function answer(path: string, status: number, body: ProviderBody): void {
  answers.set(path, { status, body });
}

function requestsTo(host: string): number {
  return requests.filter((requested) => requested === host).length;
}

function buy(transferId: string, fields: Record<string, unknown>) {
  return {
    id: `buy_${transferId}`,
    externalTransactionId: transferId,
    status: "pending",
    updatedAt: "2026-10-02T00:00:00.000Z",
    walletAddress: WALLET,
    currency: { code: "sol" },
    baseCurrency: { code: "usd" },
    ...fields,
  };
}

function session(id: string, status: string, details: Record<string, unknown>) {
  return {
    id,
    object: "crypto.onramp_session",
    livemode: false,
    status,
    transaction_details: {
      destination_currency: "usdc",
      destination_network: "solana",
      destination_amount: null,
      transaction_id: null,
      wallet_address: null,
      ...details,
    },
  };
}

function resultFor(results: RampStatusSweepResult[], provider: "moonpay" | "stripe") {
  const found = results.find((result) => result.provider === provider);
  if (!found) throw new Error(`no ${provider} tally`);
  return found;
}

function sweep() {
  return sweepRampTransferStatuses(env);
}

describe("sweepRampTransferStatuses", () => {
  installStripeTestEnv();

  let savedMoonpay: ManagedRampKeysEnv;

  beforeEach(async () => {
    savedMoonpay = {
      MOONPAY_SANDBOX_API_KEY: env.MOONPAY_SANDBOX_API_KEY,
      MOONPAY_SANDBOX_SECRET_KEY: env.MOONPAY_SANDBOX_SECRET_KEY,
      MOONPAY_PRODUCTION_API_KEY: env.MOONPAY_PRODUCTION_API_KEY,
      MOONPAY_PRODUCTION_SECRET_KEY: env.MOONPAY_PRODUCTION_SECRET_KEY,
    };
    Object.assign(env, MOONPAY_TEST_ENV);
    answers = new Map();
    requests = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url.host);
      const found = answers.get(url.pathname);
      return found === undefined
        ? Response.json({ message: "Not found" }, { status: 404 })
        : Response.json(found.body, { status: found.status });
    });
    await seedTestDatabase(env);
    const db = getDb(env);
    await db.batch([
      db
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(ORG, "Ramp Status Sweep", "ramp-status-sweep", "enterprise", "active"),
      db
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(USER, "ramp-status-sweep@example.com"),
    ]);
    await seedDefaultProjects(db, {
      organizationId: ORG,
      createdBy: USER,
      members: [],
      ids: PROJECTS,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.assign(env, savedMoonpay);
  });

  it("settles a MoonPay buy whose completed webhook never arrived, in one request", async () => {
    await seedTransfer({ id: "xfr_lost_buy", provider: "moonpay" });
    answer("/v1/transactions/ext/xfr_lost_buy", 200, [
      buy("xfr_lost_buy", {
        status: "completed",
        cryptoTransactionId: SIG,
        quoteCurrencyAmount: 0.5,
      }),
    ]);

    const results = await sweep();

    expect(requestsTo("api.moonpay.com")).toBe(1);
    expect(resultFor(results, "moonpay")).toMatchObject({ polled: 1, applied: 1, expired: 0 });
    const settled = await row("xfr_lost_buy");
    expect(settled).toMatchObject({
      status: "settling",
      signature: SIG,
      provider_reference: "buy_xfr_lost_buy",
    });
    expect(settled.provider_data.providerSettlement).toMatchObject({ onchain: { signature: SIG } });
  });

  it("recovers a Stripe delivery signature the completed webhook lacked", async () => {
    await seedTransfer({
      id: "xfr_unsigned",
      provider: "stripe",
      status: "settling",
      reference: "cos_unsigned",
      providerData: {
        providerSettlement: { reference: "cos_unsigned", receivedAmount: "10.000000" },
      },
    });
    answer(
      "/v1/crypto/onramp_sessions/cos_unsigned",
      200,
      session("cos_unsigned", "fulfillment_complete", {
        destination_amount: "10.000000",
        transaction_id: SIG,
        wallet_address: WALLET,
      })
    );

    await sweep();

    expect(requestsTo("api.stripe.com")).toBe(1);
    const recovered = await row("xfr_unsigned");
    expect(recovered).toMatchObject({ status: "settling", signature: SIG });
    expect(recovered.provider_data.providerSettlement).toMatchObject({
      onchain: { signature: SIG, destinationAddress: WALLET },
    });
  });

  it("leaves settling rows the chain verifier already holds evidence for", async () => {
    await seedTransfer({
      id: "xfr_verifier_ready",
      provider: "stripe",
      status: "settling",
      reference: "cos_ready",
      providerData: {
        providerSettlement: { reference: "cos_ready", onchain: { signature: SIG } },
      },
    });

    await sweep();

    expect(requests).toEqual([]);
  });

  it("expires checkouts that went quiet past their horizon, withdrawing a sale's deposit", async () => {
    await seedTransfer({ id: "xfr_quiet_buy", provider: "moonpay" });
    await seedTransfer({
      id: "xfr_quiet_sale",
      provider: "moonpay",
      type: "offramp",
      status: "awaiting_payment",
      reference: "sale_quiet",
      observedAt: "2026-10-01T00:00:00.000Z",
      providerData: { cryptoDeposit: { destinationAddress: WALLET, amount: "1" } },
    });
    answer("/v3/sell_transactions/ext/xfr_quiet_sale", 200, [
      {
        id: "sale_quiet",
        externalTransactionId: "xfr_quiet_sale",
        status: "waitingForDeposit",
        updatedAt: "2026-10-01T00:00:00.000Z",
        baseCurrencyAmount: 1,
        depositWallet: { walletAddress: WALLET },
        baseCurrency: { code: "sol" },
      },
    ]);
    await seedTransfer({ id: "xfr_quiet_session", provider: "stripe", reference: "cos_quiet" });
    answer("/v1/crypto/onramp_sessions/cos_quiet", 200, session("cos_quiet", "initialized", {}));

    const results = await sweep();

    expect(resultFor(results, "moonpay")).toMatchObject({ polled: 2, expired: 2 });
    expect(resultFor(results, "stripe")).toMatchObject({ polled: 1, expired: 1 });
    expect((await row("xfr_quiet_buy")).status).toBe("expired");
    expect((await row("xfr_quiet_session")).status).toBe("expired");
    const sale = await row("xfr_quiet_sale");
    expect(sale.status).toBe("expired");
    expect(sale.provider_data.cryptoDeposit).toBeNull();
  });

  it("expires a long-quiet checkout whose session only says it is unpaid", async () => {
    await seedTransfer({ id: "xfr_never_paid", provider: "stripe", reference: "cos_never_paid" });
    answer(
      "/v1/crypto/onramp_sessions/cos_never_paid",
      200,
      session("cos_never_paid", "requires_payment", {})
    );

    const results = await sweep();

    expect(resultFor(results, "stripe")).toMatchObject({ polled: 1, applied: 0, expired: 1 });
    expect((await row("xfr_never_paid")).status).toBe("expired");
  });

  it("holds a checkout whose provider reports a status SDP cannot map", async () => {
    await seedTransfer({ id: "xfr_unmapped_buy", provider: "moonpay" });
    answer("/v1/transactions/ext/xfr_unmapped_buy", 200, [
      buy("xfr_unmapped_buy", { status: "refunded" }),
    ]);
    await seedTransfer({ id: "xfr_unmapped_session", provider: "stripe", reference: "cos_paused" });
    answer(
      "/v1/crypto/onramp_sessions/cos_paused",
      200,
      session("cos_paused", "fulfillment_paused", {})
    );

    const results = await sweep();

    expect(resultFor(results, "moonpay")).toMatchObject({ polled: 1, unmapped: 1, expired: 0 });
    expect(resultFor(results, "stripe")).toMatchObject({ polled: 1, unmapped: 1, expired: 0 });
    expect((await row("xfr_unmapped_buy")).status).toBe("pending");
    expect((await row("xfr_unmapped_session")).status).toBe("pending");
  });

  it("keeps a checkout open inside its horizon and leaves webhooks their grace", async () => {
    await seedTransfer({ id: "xfr_recent", provider: "moonpay", updatedAt: minutesAgo(60) });
    await seedTransfer({ id: "xfr_in_flight", provider: "moonpay", updatedAt: minutesAgo(2) });

    await sweep();

    expect(requestsTo("api.moonpay.com")).toBe(1);
    expect((await row("xfr_recent")).status).toBe("pending");
    expect((await row("xfr_in_flight")).provider_status_last_polled_at).toBeNull();
  });

  it("never reads a failed pull or a refused event as absence", async () => {
    await seedTransfer({ id: "xfr_provider_down", provider: "moonpay" });
    answer("/v1/transactions/ext/xfr_provider_down", 500, { message: "upstream" });
    await seedTransfer({
      id: "xfr_competing",
      provider: "moonpay",
      reference: "buy_bound",
      observedAt: "2026-10-01T00:00:00.000Z",
    });
    answer("/v1/transactions/ext/xfr_competing", 200, [
      buy("xfr_competing", { id: "buy_competing", status: "pending" }),
    ]);

    const results = await sweep();

    expect(resultFor(results, "moonpay")).toMatchObject({
      polled: 2,
      failed: 1,
      refused: 1,
      expired: 0,
    });
    expect((await row("xfr_provider_down")).status).toBe("pending");
    expect((await row("xfr_competing")).status).toBe("pending");
    // Rotated anyway, so a failing row cannot hog the queue.
    await sweep();
    expect(requestsTo("api.moonpay.com")).toBe(2);
  });

  it("does not expire a checkout a webhook moved while the pull was in flight", async () => {
    await seedTransfer({ id: "xfr_raced", provider: "moonpay" });
    vi.stubGlobal("fetch", async () => {
      requests.push("api.moonpay.com");
      await getDb(env)
        .prepare("UPDATE payment_transfers SET updated_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), "xfr_raced")
        .run();
      return Response.json({ message: "Transaction not found" }, { status: 404 });
    });

    const results = await sweep();

    expect(resultFor(results, "moonpay")).toMatchObject({ polled: 1, expired: 0 });
    expect((await row("xfr_raced")).status).toBe("pending");
  });

  it("skips production rows while SDP holds no production keys", async () => {
    await seedTransfer({ id: "xfr_production", provider: "moonpay", project: PROJECTS.production });

    await sweep();

    expect(requests).toEqual([]);
    const production = await row("xfr_production");
    expect(production.status).toBe("pending");
    expect(production.provider_status_last_polled_at).toBeNull();
  });

  it("pulls production rows once the production keys are mounted, needing no webhook secret", async () => {
    Object.assign(env, MOONPAY_PRODUCTION_ENV);
    await seedTransfer({ id: "xfr_production", provider: "moonpay", project: PROJECTS.production });
    answer("/v1/transactions/ext/xfr_production", 200, [buy("xfr_production", {})]);

    const results = await sweep();

    expect(requestsTo("api.moonpay.com")).toBe(1);
    expect(resultFor(results, "moonpay")).toMatchObject({ polled: 1, failed: 0 });
    expect((await row("xfr_production")).provider_status_last_polled_at).not.toBeNull();
  });

  it("drains open transfers before expired ones", async () => {
    for (let index = 0; index < RAMP_STATUS_PULLS_PER_SWEEP; index += 1) {
      await seedTransfer({
        id: `xfr_open_${String(index).padStart(2, "0")}`,
        provider: "moonpay",
        updatedAt: minutesAgo(60),
      });
    }
    await seedTransfer({
      id: "xfr_waiting_revival",
      provider: "moonpay",
      status: "expired",
      updatedAt: minutesAgo(2 * 24 * 60),
      createdAt: minutesAgo(3 * 24 * 60),
    });

    await sweep();

    expect(requestsTo("api.moonpay.com")).toBe(RAMP_STATUS_PULLS_PER_SWEEP);
    expect((await row("xfr_waiting_revival")).provider_status_last_polled_at).toBeNull();
  });

  it("keeps sweeping a provider the release channel hides, so its transfers still finish", async () => {
    await seedTransfer({ id: "xfr_hidden", provider: "stripe", reference: "cos_hidden" });
    answer(
      "/v1/crypto/onramp_sessions/cos_hidden",
      200,
      session("cos_hidden", "fulfillment_processing", {})
    );
    const saved = env.SDP_RELEASE_CHANNEL;
    env.SDP_RELEASE_CHANNEL = "stable";
    try {
      await sweep();
    } finally {
      env.SDP_RELEASE_CHANNEL = saved;
    }

    expect(requestsTo("api.stripe.com")).toBe(1);
    expect((await row("xfr_hidden")).status).toBe("settling");
  });

  it("caps provider requests per sweep and reaches the rest on the next one", async () => {
    const total = RAMP_STATUS_PULLS_PER_SWEEP + 3;
    for (let index = 0; index < total; index += 1) {
      await seedTransfer({
        id: `xfr_queue_${String(index).padStart(2, "0")}`,
        provider: "moonpay",
        updatedAt: minutesAgo(60),
        createdAt: minutesAgo(120 - index),
      });
    }

    await sweep();
    expect(requestsTo("api.moonpay.com")).toBe(RAMP_STATUS_PULLS_PER_SWEEP);
    expect((await row("xfr_queue_00")).provider_status_last_polled_at).not.toBeNull();
    expect((await row(`xfr_queue_${total - 1}`)).provider_status_last_polled_at).toBeNull();

    await sweep();
    expect(requestsTo("api.moonpay.com")).toBe(total);
  });

  it("keeps an expired checkout expired while the provider only says it is unpaid", async () => {
    await seedTransfer({
      id: "xfr_expired_session",
      provider: "stripe",
      status: "expired",
      reference: "cos_still_unpaid",
      updatedAt: minutesAgo(2 * 24 * 60),
    });
    answer(
      "/v1/crypto/onramp_sessions/cos_still_unpaid",
      200,
      session("cos_still_unpaid", "requires_payment", {})
    );
    await seedTransfer({
      id: "xfr_expired_sale",
      provider: "moonpay",
      type: "offramp",
      status: "expired",
      reference: "sale_still_waiting",
      observedAt: "2026-10-17T00:00:00.000Z",
      updatedAt: minutesAgo(2 * 24 * 60),
    });
    answer("/v3/sell_transactions/ext/xfr_expired_sale", 200, [
      {
        id: "sale_still_waiting",
        externalTransactionId: "xfr_expired_sale",
        status: "waitingForDeposit",
        updatedAt: "2026-10-17T00:00:00.000Z",
        baseCurrencyAmount: 1,
        depositWallet: { walletAddress: WALLET },
        baseCurrency: { code: "sol" },
      },
    ]);
    const before = await row("xfr_expired_session");

    for (let pass = 0; pass < 2; pass += 1) {
      await sweep();
      await getDb(env)
        .prepare("UPDATE payment_transfers SET provider_status_last_polled_at = NULL")
        .run();
    }

    expect(requests).toHaveLength(4);
    const stripeRow = await row("xfr_expired_session");
    expect(stripeRow.status).toBe("expired");
    expect(stripeRow.updated_at).toBe(before.updated_at);
    expect((await row("xfr_expired_sale")).status).toBe("expired");
  });

  it("asks about an expired transfer for two weeks after it went quiet, then stops", async () => {
    await seedTransfer({
      id: "xfr_long_running",
      provider: "moonpay",
      status: "expired",
      createdAt: minutesAgo(20 * 24 * 60),
      updatedAt: minutesAgo(2 * 24 * 60),
    });
    await seedTransfer({
      id: "xfr_long_quiet",
      provider: "moonpay",
      status: "expired",
      createdAt: minutesAgo(20 * 24 * 60),
      updatedAt: minutesAgo(15 * 24 * 60),
    });

    await sweep();

    expect(requestsTo("api.moonpay.com")).toBe(1);
    expect((await row("xfr_long_running")).provider_status_last_polled_at).not.toBeNull();
    expect((await row("xfr_long_quiet")).provider_status_last_polled_at).toBeNull();
  });

  it("revives an expired checkout once the provider shows progress", async () => {
    await seedTransfer({
      id: "xfr_revived",
      provider: "stripe",
      status: "expired",
      reference: "cos_revived",
      updatedAt: minutesAgo(2 * 24 * 60),
    });
    answer(
      "/v1/crypto/onramp_sessions/cos_revived",
      200,
      session("cos_revived", "fulfillment_processing", {})
    );

    const results = await sweep();

    expect(resultFor(results, "stripe")).toMatchObject({ polled: 1, applied: 1 });
    expect((await row("xfr_revived")).status).toBe("settling");
  });
});
