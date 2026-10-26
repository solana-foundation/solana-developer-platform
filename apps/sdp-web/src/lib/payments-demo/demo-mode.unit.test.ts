import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rampProvidersInReleaseChannel } from "@/flags/release-channel";

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
  return {
    jar,
    store,
    // The proxy stamps the page path with its project segment, and the project header apart.
    pathname: "/dashboard/prj_sandbox/payments",
    projectHeader: null as string | null,
    // Whether the calling tab says it shows the demo (x-sdp-tab-demo).
    tabDemo: false,
    // The ramp providers the channel-capped flags leave on.
    rampProviders: [] as RampProviderId[],
    demoMode: true,
  };
});

vi.mock("@/flags", () => ({ paymentsDemoMode: async () => browser.demoMode }));
vi.mock("@/flags/ramps", () => ({ getEnabledRampProviders: async () => browser.rampProviders }));

vi.mock("next/headers", () => ({
  // A fresh store object per request, as Next gives each request its own.
  cookies: async () => ({ ...browser.store }),
  headers: async () =>
    new Headers({
      "x-sdp-pathname": browser.pathname,
      ...(browser.projectHeader === null ? {} : { "x-project-id": browser.projectHeader }),
      ...(browser.tabDemo ? { "x-sdp-tab-demo": "1" } : {}),
    }),
}));

const { paymentsDemoResponse } = await import("./demo-mode");
const { decodeDemoOps, encodeDemoOps } = await import("./demo-session");
const { DEMO_TOKENS } = await import("./demo-fixtures");

const PROJECT = "prj_sandbox";
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
  browser.pathname = "/dashboard/prj_sandbox/payments";
  browser.projectHeader = null;
  browser.tabDemo = false;
  browser.rampProviders = [...RAMP_PROVIDERS];
  browser.demoMode = true;
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
    browser.pathname = "/dashboard/prj_sandbox/wallets";
    expect((await call("GET", "/v1/counterparties")).status).toBeNull();
  });

  it("stays out of the way with the demo flag off, cookie or not", async () => {
    browser.demoMode = false;
    expect((await call("GET", "/v1/counterparties")).status).toBeNull();
  });

  it("refuses a write from a tab still showing the demo after the demo was turned off", async () => {
    browser.pathname = "/api/dashboard/payments/counterparties";
    browser.jar.delete("sdp-payments-demo");
    browser.tabDemo = true;
    const refused = await call("POST", "/v1/counterparties", {
      entityType: "business",
      displayName: "Stale Tab Ltd",
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("payments_demo_off");
    // Reads still go through, and a tab that never showed the demo is not held back.
    expect((await call("GET", "/v1/counterparties")).status).toBeNull();
    browser.tabDemo = false;
    expect((await call("POST", "/v1/counterparties", { displayName: "Real" })).status).toBeNull();
  });

  it("never holds back the API playground's writes", async () => {
    browser.pathname = "/api/playground/v1/counterparties";
    browser.jar.delete("sdp-payments-demo");
    browser.tabDemo = true;
    expect((await call("POST", "/v1/counterparties", { displayName: "Real" })).status).toBeNull();
  });

  it("answers anything about payment data itself, and lets project reads through", async () => {
    expect((await call("GET", "/v1/counterparties/cpty_real")).status).toBe(404);
    expect((await call("GET", "/v1/payments/transfers/xfr_real")).status).toBe(404);
    expect((await call("GET", "/v1/projects")).status).toBeNull();
  });

  it("offers every ramp provider, on the organization's real provider answer", async () => {
    // An organization-level read names no project; the request's own project header decides.
    browser.projectHeader = PROJECT;
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

  it("offers only the ramp providers the channel-capped flags leave on", async () => {
    browser.projectHeader = PROJECT;
    browser.rampProviders = ["moonpay"];
    upstream.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const response = await paymentsDemoResponse(
      "GET",
      "/v1/organizations/org_1/provider-access",
      null,
      undefined,
      upstream
    );
    const body = await response?.json();
    const ramps = body.data.providers.ramps as Record<RampProviderId, { enabled: boolean }>;
    expect(RAMP_PROVIDERS.filter((provider) => ramps[provider].enabled).sort()).toEqual([
      "moonpay",
    ]);
    upstream.mockClear();
  });

  it("does not answer an organization-level read without a project to judge it by", async () => {
    browser.projectHeader = null;
    const response = await paymentsDemoResponse(
      "GET",
      "/v1/organizations/org_1/provider-access",
      null,
      undefined,
      upstream
    );
    expect(response).toBeNull();
  });

  it("offers every provider even when the API can't be reached", async () => {
    browser.projectHeader = PROJECT;
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

describe("ramps and the release channel", () => {
  const quote = (provider: string) =>
    call("POST", "/v1/payments/ramps/onramp/quote", {
      provider,
      counterpartyId: "demo_cpty_jane",
      destinationCustodyWalletId: "demo_cwlt_treasury",
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      fiatAmount: "500",
    });

  it("refuses a quote from a provider the channel leaves out, as the API would", async () => {
    browser.rampProviders = ["moonpay"];
    expect((await quote("stripe")).status).toBe(400);
    expect((await quote("moonpay")).status).toBe(201);
  });

  it("walks no ramp stable hides: no sample transfer of one and every quote refused", async () => {
    // The providers stable's capped flags leave on, from the maturity table, not picked here.
    browser.rampProviders = rampProvidersInReleaseChannel("stable");
    const hidden = RAMP_PROVIDERS.filter((provider) => !browser.rampProviders.includes(provider));
    const transfers = await data<{ id: string; provider?: string }[]>(
      "/v1/payments/transfers?pageSize=100"
    );
    expect(transfers.length).toBeGreaterThan(0);
    expect(
      transfers.filter(({ provider }) =>
        hidden.some((hiddenProvider) => hiddenProvider === provider)
      )
    ).toEqual([]);
    for (const provider of hidden) {
      expect((await quote(provider)).status, provider).toBe(400);
    }
  });

  it("leaves a sample ramp transfer of a hidden provider out of the lists", async () => {
    const ids = async () =>
      (await data<{ id: string }[]>("/v1/payments/transfers?pageSize=100")).map(
        (transfer) => transfer.id
      );
    expect(await ids()).toContain("demo_xfr_onramp_moonpay");
    browser.rampProviders = RAMP_PROVIDERS.filter((provider) => provider !== "moonpay");
    expect(await ids()).not.toContain("demo_xfr_onramp_moonpay");
  });
});

describe("ramps", () => {
  it("runs a deposit from quote to a completed transfer, then credits the wallet", async () => {
    const requirements = await data<{ status: string }>(
      "/v1/counterparties/demo_cpty_jane/requirements?provider=moonpay&direction=onramp&assetRail=usdc.solana&fiatCurrency=USD"
    );
    expect(requirements.status).toBe("ready");
    const estimate = await call("POST", "/v1/payments/ramps/onramp/estimate", {
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      fiatAmount: "500",
    });
    expect(estimate.body.data.estimates[0].status).toBe("ok");

    const quoted = await call("POST", "/v1/payments/ramps/onramp/quote", {
      provider: "moonpay",
      counterpartyId: "demo_cpty_jane",
      destinationCustodyWalletId: "demo_cwlt_treasury",
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      fiatAmount: "500",
    });
    expect(quoted.status).toBe(201);
    const { quote, transferId } = quoted.body.data;
    expect(quote.deliveryMode).toBe("hosted");
    const waiting = await data<{ transfer: { status: string } }>(
      `/v1/payments/transfers/${transferId}`
    );
    expect(waiting.transfer.status).toBe("awaiting_payment");

    const paid = await call("POST", "/v1/payments/ramps/sandbox/simulate", { transferId });
    expect(paid.status).toBe(204);
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

  it("pays out once the crypto is sent", async () => {
    const requirements = await data<{ status: string }>(
      "/v1/counterparties/demo_cpty_jane/requirements?provider=moonpay&direction=offramp&assetRail=usdc.solana&fiatCurrency=USD"
    );
    expect(requirements.status).toBe("ready");

    const quoted = await call("POST", "/v1/payments/ramps/offramp/quote", {
      provider: "moonpay",
      counterpartyId: "demo_cpty_jane",
      sourceCustodyWalletId: "demo_cwlt_treasury",
      assetRail: "usdc.solana",
      cryptoAmount: "300",
      fiatCurrency: "USD",
    });
    const { quote, transferId } = quoted.body.data;
    expect(quote.deliveryMode).toBe("hosted");
    const waiting = await data<{ transfer: { cryptoDeposit: { destinationAddress: string } } }>(
      `/v1/payments/transfers/${transferId}`
    );
    const deposit = waiting.transfer.cryptoDeposit;
    expect(deposit.destinationAddress).toBeTruthy();

    const funded = await call("POST", "/v1/payments/transfers", {
      transferId,
      sourceCustodyWalletId: "demo_cwlt_treasury",
      destination: deposit.destinationAddress,
      token: USDC,
      amount: "300",
    });
    expect(funded.body.data.transfer.id).toBe(transferId);
    vi.setSystemTime(new Date(Date.now() + 6_000));
    expect(
      (await data<{ transfer: { status: string } }>(`/v1/payments/transfers/${transferId}`))
        .transfer.status
    ).toBe("completed");
  });

  it("cancels a deposit before it is paid", async () => {
    const quoted = await call("POST", "/v1/payments/ramps/onramp/quote", {
      provider: "moonpay",
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
    expect(results.map((result) => result.provider).sort()).toEqual(["moonpay", "stripe"]);
    expect(new Set(results.map((result) => result.estimate.fees.total)).size).toBe(2);
    // 250 USD less MoonPay's 3.5%, at 148.20 USD a SOL.
    expect(results.find((result) => result.provider === "moonpay")?.estimate.cryptoAmount).toBe(
      "1.6279"
    );
  });

  it.each([
    ["moonpay", "hosted"],
    ["stripe", "session_widget"],
  ])(
    "runs a %s deposit from its stand-in checkout to a credited wallet",
    async (provider, mode) => {
      const quoted = await onrampQuote(provider, "sol.solana");
      expect(quoted.status).toBe(201);
      const { quote, transferId } = quoted.body.data;
      expect(quote).toMatchObject({ provider, deliveryMode: mode });

      const paid = await call("POST", "/v1/payments/ramps/sandbox/simulate", { transferId });
      expect(paid.status).toBe(204);
      expect(await statusAfterSettling(transferId)).toMatchObject({
        status: "completed",
        provider,
        token: DEMO_TOKENS.SOL.mint,
      });
    }
  );

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
