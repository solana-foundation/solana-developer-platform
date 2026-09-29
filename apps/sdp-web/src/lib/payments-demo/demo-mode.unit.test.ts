import { RAMP_PROVIDERS } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Demo mode end to end: every request is what a Payments screen's route handler would send the
 * SDP API, answered by the demo with the browser's demo session carried between requests as a
 * browser would carry its cookies. Nothing may reach the real API except the reads that aren't
 * about payment data.
 */

const browser = vi.hoisted(() => {
  const jar = new Map<string, string>();
  const store = {
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) ?? "" } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  };
  return { jar, store, pathname: "/dashboard/payments", newDesign: true };
});

// Demo mode is part of the new design; the flag itself reads Vercel and the request.
vi.mock("@/flags", () => ({ newDesign: async () => browser.newDesign }));

vi.mock("next/headers", () => ({
  // A fresh store object per request, as Next gives each request its own.
  cookies: async () => ({ ...browser.store }),
  headers: async () => new Headers({ "x-sdp-pathname": browser.pathname }),
}));

const { paymentsDemoResponse } = await import("./demo-mode");
const { decodeDemoOps, encodeDemoOps } = await import("./demo-session");
const { DEMO_TOKENS } = await import("./demo-fixtures");
const { PROJECT_COOKIE_NAME } = await import("../project-cookie");

const PROJECT = "proj_sandbox";
const USDC = DEMO_TOKENS.USDC.mint;
const NOW = new Date("2026-09-28T12:00:00.000Z");
const upstream = vi.fn(async () => Response.json({ data: { ok: true } }));

async function call(method: string, path: string, body?: unknown) {
  const response = await paymentsDemoResponse(
    method,
    path,
    PROJECT,
    body === undefined ? undefined : JSON.stringify(body),
    upstream
  );
  if (response === null) return { status: null, body: null };
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function data<T>(path: string): Promise<T> {
  const { status, body } = await call("GET", path);
  expect(status).toBe(200);
  return body.data as T;
}

beforeEach(() => {
  browser.jar.clear();
  browser.jar.set("sdp-payments-demo", PROJECT);
  browser.pathname = "/dashboard/payments";
  browser.newDesign = true;
  upstream.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  // Payment data never leaves the demo.
  expect(upstream).not.toHaveBeenCalled();
});

describe("scope", () => {
  it("stays out of the way without the demo cookie, or off the Payments screens", async () => {
    browser.jar.delete("sdp-payments-demo");
    expect((await call("GET", "/v1/counterparties")).status).toBeNull();
    browser.jar.set("sdp-payments-demo", PROJECT);
    browser.pathname = "/dashboard/wallets";
    expect((await call("GET", "/v1/counterparties")).status).toBeNull();
  });

  it("stays out of the way with NEW DESIGN off, cookie or not", async () => {
    browser.newDesign = false;
    expect((await call("GET", "/v1/counterparties")).status).toBeNull();
  });

  it("answers anything about payment data itself, and lets project reads through", async () => {
    expect((await call("GET", "/v1/counterparties/cpty_real")).status).toBe(404);
    expect((await call("GET", "/v1/payments/transfers/xfr_real")).status).toBe(404);
    expect((await call("GET", "/v1/projects")).status).toBeNull();
    expect((await call("GET", "/v1/wallets/approval-requests?status=pending")).body).toEqual({
      data: { approvalRequests: [] },
    });
  });

  it("offers Lightspark as the only ramp, on the organization's real provider answer", async () => {
    // An organization-level read names no project; the dashboard's selected one decides.
    browser.jar.set(PROJECT_COOKIE_NAME, PROJECT);
    upstream.mockResolvedValueOnce(
      Response.json({
        data: {
          tier: "sandbox",
          providers: {
            ramps: { moonpay: { entitled: true, configured: true, enabled: true } },
            compliance: {},
          },
        },
      })
    );
    const response = await paymentsDemoResponse(
      "GET",
      "/v1/organizations/org_1/provider-access",
      null,
      undefined,
      upstream
    );
    const body = await response?.json();
    for (const provider of RAMP_PROVIDERS) {
      expect(body.data.providers.ramps[provider].enabled).toBe(true);
    }
    expect(body.data.providers.compliance.range.enabled).toBe(true);
    upstream.mockClear();
  });

  it("offers every provider even when the API can't be reached", async () => {
    browser.jar.set(PROJECT_COOKIE_NAME, PROJECT);
    upstream.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const response = await paymentsDemoResponse(
      "GET",
      "/v1/organizations/org_1/provider-access",
      null,
      undefined,
      upstream
    );
    const body = await response?.json();
    expect(response?.status).toBe(200);
    expect(body.data.providers.ramps.stripe.enabled).toBe(true);
    expect(body.data.providers.compliance.range.enabled).toBe(true);
    upstream.mockClear();
  });
});

describe("contacts", () => {
  it("creates a contact with an address, lists it, and archives it", async () => {
    const created = await call("POST", "/v1/counterparties", {
      entityType: "business",
      displayName: "Harbor Freight Co",
    });
    expect(created.status).toBe(201);
    const id: string = created.body.data.counterparty.id;
    expect(id).toMatch(/^demo_new_cpty_/);

    const screening = await call("POST", "/v1/compliance/address-screenings", {
      address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      network: "solana",
    });
    expect(screening.body.data.screening.providers[0].status).toBe("ok");

    const account = await call("POST", `/v1/counterparties/${id}/accounts`, {
      accountKind: "crypto_wallet",
      label: "Treasury",
      details: { network: "solana", address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" },
    });
    expect(account.status).toBe(201);

    const list = await data<{ counterparties: { id: string }[] }>("/v1/counterparties?page=1");
    expect(list.counterparties[0]?.id).toBe(id);
    const accounts = await data<{ accounts: { label: string }[] }>(
      `/v1/counterparties/${id}/accounts`
    );
    expect(accounts.accounts.map((entry) => entry.label)).toEqual(["Treasury"]);

    expect((await call("DELETE", `/v1/counterparties/${id}`)).status).toBe(204);
    const after = await data<{ counterparties: { id: string }[] }>("/v1/counterparties?page=1");
    expect(after.counterparties.some((contact) => contact.id === id)).toBe(false);
  });

  it("refuses what the API would: a bad address, a duplicate external ID", async () => {
    const bad = await call("POST", "/v1/counterparties/demo_cpty_jane/accounts", {
      accountKind: "crypto_wallet",
      details: { network: "solana", address: "not-an-address" },
    });
    expect(bad.status).toBe(400);
    const duplicate = await call("POST", "/v1/counterparties", {
      entityType: "business",
      displayName: "Acme again",
      externalId: "ACME-001",
    });
    expect(duplicate.status).toBe(409);
  });
});

describe("pay", () => {
  it("sends a payment that lists in Transactions and lowers the wallet's balance", async () => {
    const before = await data<{
      wallets: { id: string; balances: { mint: string; uiAmount: string }[] }[];
    }>("/v1/wallets?includeBalances=true");
    const treasury = before.wallets.find((wallet) => wallet.id === "demo_cwlt_treasury");
    const held = Number(treasury?.balances.find((balance) => balance.mint === USDC)?.uiAmount);

    const sent = await call("POST", "/v1/payments/transfers", {
      sourceCustodyWalletId: "demo_cwlt_treasury",
      destination: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      token: USDC,
      amount: "250.00",
    });
    expect(sent.status).toBe(201);
    expect(sent.body.data.transfer.status).toBe("finalized");
    expect(sent.body.data.transfer.signature).toBeTruthy();

    const transactions = await data<{ transactions: { id: string }[] }>("/v1/transactions?limit=5");
    expect(transactions.transactions[0]?.id).toBe(sent.body.data.transfer.id);
    const after = await data<{
      wallets: { id: string; balances: { mint: string; uiAmount: string }[] }[];
    }>("/v1/wallets?includeBalances=true");
    const now = after.wallets.find((wallet) => wallet.id === "demo_cwlt_treasury");
    expect(Number(now?.balances.find((balance) => balance.mint === USDC)?.uiAmount)).toBe(
      held - 250
    );
  });

  it("refuses a payment the wallet cannot cover", async () => {
    const refused = await call("POST", "/v1/payments/transfers", {
      sourceCustodyWalletId: "demo_cwlt_settlement",
      destination: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      token: USDC,
      amount: "1000000",
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/^Not enough USDC in Settlement/);
  });

  it("pays a batch in one go", async () => {
    const recipients = [
      { counterpartyId: "demo_cpty_kai", counterpartyAccountId: "demo_cpa_kai", amount: "100" },
      { counterpartyId: "demo_cpty_priya", counterpartyAccountId: "demo_cpa_priya", amount: "50" },
    ];
    const estimate = await call("POST", "/v1/payments/transfer-batches/estimate", {
      sourceCustodyWalletId: "demo_cwlt_payroll",
      token: USDC,
      recipients,
    });
    expect(estimate.body.data.estimate.recipientCount).toBe(2);
    const batch = await call("POST", "/v1/payments/transfer-batches", {
      sourceCustodyWalletId: "demo_cwlt_payroll",
      token: USDC,
      recipients,
    });
    expect(batch.status).toBe(201);
    expect(batch.body.data.batch.status).toBe("confirmed");
    expect(batch.body.data.recipients).toHaveLength(2);
    expect(batch.body.data.transfers).toHaveLength(1);
  });
});

describe("ramps", () => {
  it("runs a deposit from quote to a completed transfer, then credits the wallet", async () => {
    const requirements = await data<{ status: string }>(
      "/v1/counterparties/demo_cpty_jane/requirements?provider=lightspark&direction=onramp&assetRail=usdc.solana&fiatCurrency=USD"
    );
    expect(requirements.status).toBe("ready");
    const estimate = await call("POST", "/v1/payments/ramps/onramp/estimate", {
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      fiatAmount: "500",
    });
    expect(estimate.body.data.estimates[0].status).toBe("ok");

    const quoted = await call("POST", "/v1/payments/ramps/onramp/quote", {
      provider: "lightspark",
      counterpartyId: "demo_cpty_jane",
      destinationCustodyWalletId: "demo_cwlt_treasury",
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      fiatAmount: "500",
    });
    expect(quoted.status).toBe(201);
    const { quote, transferId } = quoted.body.data;
    expect(quote.paymentInstructions[0].accountOrWalletInfo.accountType).toBe("US_ACCOUNT");
    const waiting = await data<{ transfer: { status: string } }>(
      `/v1/payments/transfers/${transferId}`
    );
    expect(waiting.transfer.status).toBe("awaiting_payment");

    const paid = await call("POST", "/v1/payments/ramps/sandbox/simulate", {
      provider: "lightspark",
      payload: { quoteId: quote.id, currencyCode: "USD" },
    });
    expect(paid.status).toBe(200);
    expect(
      (await data<{ transfer: { status: string } }>(`/v1/payments/transfers/${transferId}`))
        .transfer.status
    ).toBe("settling");
    vi.setSystemTime(new Date(NOW.getTime() + 6_000));
    const done = await data<{ transfer: { status: string; signature: string } }>(
      `/v1/payments/transfers/${transferId}`
    );
    expect(done.transfer.status).toBe("completed");
    expect(done.transfer.signature).toBeTruthy();
  });

  it("pays out to a saved bank account once the crypto is sent", async () => {
    const requirements = await data<{
      status: string;
      payout: { accounts: { id: string; destinationCountry: string }[] };
    }>(
      "/v1/counterparties/demo_cpty_jane/requirements?provider=lightspark&direction=offramp&assetRail=usdc.solana&fiatCurrency=USD"
    );
    expect(requirements.status).toBe("collect_account");
    const saved = requirements.payout.accounts[0];
    expect(saved?.destinationCountry).toBe("US");

    const advanced = await call("POST", "/v1/counterparties/demo_cpty_jane/requirements", {
      provider: "lightspark",
      direction: "offramp",
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      destinationCustodyWalletId: "demo_cwlt_treasury",
      collectedData: { destinationCountry: "US" },
      providerAccountId: saved?.id,
    });
    expect(advanced.body.data).toMatchObject({ status: "ready", providerAccountId: saved?.id });

    const quoted = await call("POST", "/v1/payments/ramps/offramp/quote", {
      provider: "lightspark",
      counterpartyId: "demo_cpty_jane",
      sourceCustodyWalletId: "demo_cwlt_treasury",
      assetRail: "usdc.solana",
      cryptoAmount: "300",
      fiatCurrency: "USD",
      destinationCountry: "US",
      providerAccountId: saved?.id,
    });
    const { quote, transferId } = quoted.body.data;
    const deposit = quote.paymentInstructions[0];
    expect(deposit.kind).toBe("crypto_deposit");

    const funded = await call("POST", "/v1/payments/transfers", {
      transferId,
      sourceCustodyWalletId: "demo_cwlt_treasury",
      destination: deposit.destinationAddress,
      token: USDC,
      amount: "300",
    });
    expect(funded.body.data.transfer.id).toBe(transferId);
    vi.setSystemTime(new Date(NOW.getTime() + 6_000));
    expect(
      (await data<{ transfer: { status: string } }>(`/v1/payments/transfers/${transferId}`))
        .transfer.status
    ).toBe("completed");
  });

  it("adds a new bank account from the collected details", async () => {
    const advanced = await call("POST", "/v1/counterparties/demo_cpty_priya/requirements", {
      provider: "lightspark",
      direction: "offramp",
      fiatCurrency: "GBP",
      collectedData: {
        destinationCountry: "GB",
        bankName: "Monzo",
        accountNumber: "12345678",
        sortCode: "040004",
      },
    });
    const id: string = advanced.body.data.providerAccountId;
    const accounts = await data<{ accounts: { id: string; bankName: string }[] }>(
      "/v1/counterparties/demo_cpty_priya/provider-accounts"
    );
    expect(accounts.accounts.find((entry) => entry.id === id)?.bankName).toBe("Monzo");
  });

  it("cancels a deposit before it is paid", async () => {
    const quoted = await call("POST", "/v1/payments/ramps/onramp/quote", {
      provider: "lightspark",
      counterpartyId: "demo_cpty_kai",
      destinationCustodyWalletId: "demo_cwlt_payroll",
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      fiatAmount: "80",
    });
    const canceled = await call("POST", "/v1/payments/ramps/transfers/cancel", {
      transferId: quoted.body.data.transferId,
    });
    expect(canceled.body.data.transfer.status).toBe("canceled");
  });
});

describe("every ramp provider", () => {
  const onrampQuote = (provider: string, assetRail: string, fiatCurrency = "USD") =>
    call("POST", "/v1/payments/ramps/onramp/quote", {
      provider,
      counterpartyId: "demo_cpty_jane",
      destinationCustodyWalletId: "demo_cwlt_treasury",
      assetRail,
      fiatCurrency,
      fiatAmount: "250",
    });

  async function statusAfterSettling(transferId: string) {
    vi.setSystemTime(new Date(Date.now() + 6_000));
    return (
      await data<{ transfer: { status: string; provider: string; token: string } }>(
        `/v1/payments/transfers/${transferId}`
      )
    ).transfer;
  }

  it("estimates with every provider that runs the pair, each at its own fee", async () => {
    const estimate = await call("POST", "/v1/payments/ramps/onramp/estimate", {
      assetRail: "sol.solana",
      fiatCurrency: "USD",
      fiatAmount: "250",
    });
    const results: {
      provider: string;
      estimate: { cryptoAmount: string; fees: { total: string } };
    }[] = estimate.body.data.estimates;
    expect(results.map((result) => result.provider).sort()).toEqual([
      "bvnk",
      "coinbase",
      "moonpay",
      "stripe",
    ]);
    expect(new Set(results.map((result) => result.estimate.fees.total)).size).toBe(4);
    // 250 USD less MoonPay's 3.5%, at 148.20 USD a SOL.
    expect(results.find((result) => result.provider === "moonpay")?.estimate.cryptoAmount).toBe(
      "1.6279"
    );
  });

  it.each([
    ["moonpay", "hosted"],
    ["coinbase", "hosted"],
    ["stripe", "session_widget"],
  ])(
    "runs a %s deposit from its stand-in checkout to a credited wallet",
    async (provider, mode) => {
      const quoted = await onrampQuote(provider, "sol.solana");
      expect(quoted.status).toBe(201);
      const { quote, transferId } = quoted.body.data;
      expect(quote).toMatchObject({ provider, deliveryMode: mode });

      const paid = await call("POST", "/v1/payments/ramps/sandbox/simulate", {
        provider,
        payload: { transferId },
      });
      expect(paid.status).toBe(200);
      expect(await statusAfterSettling(transferId)).toMatchObject({
        status: "completed",
        provider,
        token: DEMO_TOKENS.SOL.mint,
      });
    }
  );

  it("runs a MoneyGram deposit and pays out through MoneyGram", async () => {
    const deposit = await onrampQuote("moneygram", "usdc.solana");
    expect(deposit.body.data.quote.deliveryMode).toBe("session_widget");
    await call("POST", "/v1/payments/ramps/sandbox/simulate", {
      provider: "moneygram",
      payload: { transferId: deposit.body.data.transferId },
    });
    expect((await statusAfterSettling(deposit.body.data.transferId)).status).toBe("completed");

    const payout = await call("POST", "/v1/payments/ramps/offramp/quote", {
      provider: "moneygram",
      counterpartyId: "demo_cpty_jane",
      sourceCustodyWalletId: "demo_cwlt_treasury",
      assetRail: "usdc.solana",
      cryptoAmount: "100",
      fiatCurrency: "USD",
    });
    const { transferId } = payout.body.data;
    const waiting = await data<{
      transfer: { cryptoDeposit: { destinationAddress: string; amount: string } };
    }>(`/v1/payments/transfers/${transferId}`);
    expect(waiting.transfer.cryptoDeposit.amount).toBe("100");
    const funded = await call("POST", "/v1/payments/transfers", {
      transferId,
      sourceCustodyWalletId: "demo_cwlt_treasury",
      destination: waiting.transfer.cryptoDeposit.destinationAddress,
      token: USDC,
      amount: "100",
    });
    expect(funded.status).toBe(201);
    expect((await statusAfterSettling(transferId)).status).toBe("completed");
  });

  it("runs BVNK's onboarding: agreements, a simulated identity check, review, then the deposit", async () => {
    const path =
      "/v1/counterparties/demo_cpty_jane/requirements?provider=bvnk&direction=onramp&assetRail=usdc.solana&fiatCurrency=EUR";
    const status = async () => (await data<{ status: string }>(path)).status;
    const advance = (extra: Record<string, unknown>) =>
      call("POST", "/v1/counterparties/demo_cpty_jane/requirements", {
        provider: "bvnk",
        direction: "onramp",
        assetRail: "usdc.solana",
        fiatCurrency: "EUR",
        ...extra,
      });
    const simulateVerification = (counterpartyId = "demo_cpty_jane", provider = "bvnk") =>
      call("POST", "/v1/payments/ramps/sandbox/simulate", {
        provider,
        payload: { counterpartyId, verification: "approved" },
      });

    expect(await status()).toBe("counterparty_collect_agreement");
    expect((await advance({ collectedData: {} })).body.data.status).toBe(
      "counterparty_collect_agreement"
    );
    expect((await simulateVerification()).status).toBe(409);
    expect((await onrampQuote("bvnk", "usdc.solana", "EUR")).status).toBe(409);

    const consented = await advance({ agreementConsent: true });
    expect(consented.body.data).toMatchObject({
      status: "customer_verification_required",
      verificationUrl: expect.stringMatching(/^https:\/\//),
    });
    expect(await status()).toBe("customer_verification_required");

    expect((await simulateVerification("demo_cpty_jane", "mural")).status).toBe(400);
    expect((await simulateVerification()).status).toBe(200);
    expect(await status()).toBe("customer_verifying");
    expect((await simulateVerification()).status).toBe(409);
    expect((await onrampQuote("bvnk", "usdc.solana", "EUR")).status).toBe(409);

    vi.setSystemTime(new Date(Date.now() + 9_000));
    expect(await status()).toBe("customer_funding_account_provisioning");
    vi.setSystemTime(new Date(Date.now() + 5_000));
    expect(await status()).toBe("ready");
    expect((await advance({ collectedData: {} })).body.data.status).toBe("ready");

    const quoted = await onrampQuote("bvnk", "usdc.solana", "EUR");
    const { quote, transferId } = quoted.body.data;
    expect(quote.paymentInstructions[0]).toMatchObject({
      kind: "fiat_funding",
      onboardingStatus: "ready",
    });
    await call("POST", "/v1/payments/ramps/sandbox/simulate", {
      provider: "bvnk",
      payload: { transferId },
    });
    expect((await statusAfterSettling(transferId)).status).toBe("completed");
  });

  it("runs a Mural deposit for a business contact", async () => {
    const quoted = await call("POST", "/v1/payments/ramps/onramp/quote", {
      provider: "mural",
      counterpartyId: "demo_cpty_acme",
      destinationCustodyWalletId: "demo_cwlt_treasury",
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      fiatAmount: "250",
    });
    expect(quoted.body.data.quote.paymentInstructions[0].bankDetails.bankName).toBeTruthy();
    await call("POST", "/v1/payments/ramps/sandbox/simulate", {
      provider: "mural",
      payload: { counterpartyId: "demo_cpty_acme", amount: 250, fiatCurrency: "USD" },
    });
    expect((await statusAfterSettling(quoted.body.data.transferId)).status).toBe("completed");
  });

  it("refuses a provider on a pair it doesn't run", async () => {
    const refused = await onrampQuote("stripe", "usdc.solana", "EUR");
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe("Stripe doesn't run EUR to USDC.");
  });
});

describe("requests and schedules", () => {
  it("creates a payment request the list and its page can find", async () => {
    const created = await call("POST", "/v1/payments/requests", {
      walletId: "demo_privy_treasury",
      token: USDC,
      amount: "75.00",
      counterpartyId: null,
      expiresAt: null,
    });
    expect(created.status).toBe(201);
    const list = await data<{ paymentRequests: { id: string }[] }>(
      "/v1/payments/requests?page=1&pageSize=100"
    );
    expect(list.paymentRequests[0]?.id).toBe(created.body.data.id);
    expect(created.body.data.publicToken).toMatch(/^demo_pt_/);
  });

  it("creates, activates, collects, cancels and resumes a schedule", async () => {
    const created = await call("POST", "/v1/payments/recurring-payments", {
      sourceCustodyWalletId: "demo_cwlt_payroll",
      counterpartyId: "demo_cpty_kai",
      counterpartyAccountId: "demo_cpa_kai",
      token: USDC,
      amount: "40",
      periodHours: 168,
    });
    expect(created.status).toBe(201);
    const id: string = created.body.data.recurringPayment.id;
    expect(created.body.data.recurringPayment.status).toBe("pending_activation");

    const run = (action: string) =>
      call("POST", `/v1/payments/recurring-payments/${id}/${action}`, {});
    expect((await run("collect")).status).toBe(409);
    expect((await run("activate")).body.data.recurringPayment.status).toBe("active");
    const collected = await run("collect");
    expect(collected.status).toBe(200);
    const schedule = collected.body.data.recurringPayment;
    const attempts = await data<{ collectionAttempts: { status: string }[] }>(
      `/v1/payments/subscriptions/${schedule.subscriptionId}/collection-attempts`
    );
    expect(attempts.collectionAttempts.map((attempt) => attempt.status)).toEqual(["confirmed"]);
    expect((await run("collect")).status).toBe(409);

    const updated = await call("PATCH", `/v1/payments/recurring-payments/${id}`, {
      amount: "45",
    });
    expect(updated.body.data.recurringPayment.amount).toBe("45");
    expect((await run("cancel")).body.data.recurringPayment.status).toBe("canceled");
    expect((await run("resume")).body.data.recurringPayment.status).toBe("active");
  });
});

describe("session", () => {
  it("round-trips the log, and drops the oldest actions past its budget", () => {
    const ops = Array.from({ length: 400 }, (_, index) => ({
      k: "contact" as const,
      id: `demo_new_cpty_${index.toString(36).padStart(12, "x")}`,
      at: NOW.getTime() + index,
      name: `Contact ${crypto.randomUUID()}`,
      entity: "business" as const,
      ext: null,
    }));
    expect(decodeDemoOps(encodeDemoOps(ops.slice(0, 3)))).toEqual(ops.slice(0, 3));
    const chunks = encodeDemoOps(ops);
    const kept = decodeDemoOps(chunks);
    expect(chunks.length).toBeLessThanOrEqual(3);
    expect(kept.length).toBeLessThan(ops.length);
    expect(kept.at(-1)).toEqual(ops.at(-1));
    expect(decodeDemoOps(["not base64 at all"])).toEqual([]);
  });
});
