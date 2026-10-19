import { OFFRAMP_SUPPORT, ONRAMP_SUPPORT, RAMP_PROVIDERS, type RampProviderId } from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { buildWorld, DEMO_TOKENS, demoPathParts } from "./demo-fixtures";
import { demoFlowRead, demoWrite } from "./demo-handlers";
import type { DemoOp } from "./demo-ops";
import { DEMO_RAMP_ASSETS, demoRampPairs, isDemoRampRail } from "./demo-ramp-assets";
import { applyDemoOps, tokenKeyForRail, transferById } from "./demo-replay";

/*
 * The demo's write handlers on their own: each refuses what the SDP API would refuse, with the
 * status it would send, and records nothing when it does. The session is a plain log here,
 * carried from write to write as the browser's cookies would carry it.
 */

const NOW = new Date("2026-09-28T12:00:00.000Z");
const USDC = DEMO_TOKENS.USDC.mint;
const ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const TREASURY = "demo_cwlt_treasury";

let ops: DemoOp[] = [];
let now = NOW;

function world() {
  return applyDemoOps(buildWorld(now, RAMP_PROVIDERS), ops, now);
}

function write(method: string, path: string, body: unknown = {}) {
  const parts = demoPathParts(path);
  if (!parts) throw new Error(`not a demo path: ${path}`);
  const result = demoWrite(method, { segments: parts.segments, body, world: world(), ops, now });
  if (!result) return undefined;
  ops = [...ops, ...result.ops];
  // biome-ignore lint/suspicious/noExplicitAny: test reads loosely shaped API envelopes.
  return result.answer(world()) as { status: number; body: any };
}

function read(path: string) {
  const parts = demoPathParts(path);
  if (!parts) throw new Error(`not a demo path: ${path}`);
  // biome-ignore lint/suspicious/noExplicitAny: test reads loosely shaped API envelopes.
  return demoFlowRead(parts.segments, parts.params, world(), now) as { status: number; body: any };
}

function refusal(answer: ReturnType<typeof write>) {
  return [answer?.status, answer?.body?.error?.code];
}

beforeEach(() => {
  ops = [];
  now = NOW;
});

describe("routing", () => {
  it("has no stand-in for a write it doesn't know", () => {
    expect(write("POST", "/v1/payments/unknown-thing")).toBeUndefined();
    expect(write("PUT", "/v1/counterparties")).toBeUndefined();
    expect(read("/v1/payments/unknown-thing")).toBeUndefined();
  });

  it("answers a ramp event with nothing to record", () => {
    expect(write("POST", "/v1/payments/ramps/onramp/events")?.status).toBe(204);
    expect(ops).toEqual([]);
  });
});

describe("contacts", () => {
  it("names the field a body gets wrong, or the request when it isn't an object", () => {
    expect(
      write("POST", "/v1/counterparties", { entityType: "robot" })?.body.error.message
    ).toMatch(/^entityType: /);
    expect(write("POST", "/v1/counterparties", null)?.status).toBe(400);
    expect(ops).toEqual([]);
  });

  it("refuses an unknown contact, a bad address and a duplicate one", () => {
    expect(refusal(write("DELETE", "/v1/counterparties/demo_cpty_nobody"))).toEqual([
      404,
      "not_found",
    ]);
    const account = { accountKind: "crypto_wallet", details: { address: ADDRESS } };
    expect(write("POST", "/v1/counterparties/demo_cpty_nobody/accounts", account)?.status).toBe(
      404
    );
    expect(
      write("POST", "/v1/counterparties/demo_cpty_jane/accounts", { accountKind: "bank" })?.status
    ).toBe(400);
    expect(write("POST", "/v1/counterparties/demo_cpty_jane/accounts", account)?.status).toBe(201);
    expect(refusal(write("POST", "/v1/counterparties/demo_cpty_jane/accounts", account))).toEqual([
      409,
      "conflict",
    ]);
  });

  it("creates a contact without an external ID, and screens only a valid address", () => {
    const created = write("POST", "/v1/counterparties", {
      entityType: "individual",
      displayName: "Rae",
      externalId: "",
    });
    expect(created?.body.data.counterparty.externalId).toBeNull();
    expect(write("POST", "/v1/compliance/address-screenings", { address: "nope" })?.status).toBe(
      400
    );
  });
});

describe("ramp requirements", () => {
  it("refuses an unknown contact, and an unknown provider", () => {
    expect(read("/v1/counterparties/demo_cpty_nobody/requirements").status).toBe(404);
    expect(refusal(read("/v1/counterparties/demo_cpty_jane/requirements?provider=acme"))).toEqual([
      400,
      "invalid_request",
    ]);
    const advance = (body: unknown, id = "demo_cpty_jane") =>
      write("POST", `/v1/counterparties/${id}/requirements`, body);
    expect(advance({ provider: "moonpay", direction: "onramp" }, "demo_cpty_x")?.status).toBe(404);
    expect(advance({ provider: "moonpay" })?.status).toBe(400);
    expect(advance({ provider: "acme", direction: "onramp" })?.status).toBe(400);
  });

  it("is ready at once with providers that run no onboarding", () => {
    for (const provider of ["moonpay", "stripe"]) {
      expect(
        read(`/v1/counterparties/demo_cpty_jane/requirements?provider=${provider}`).body.data.status
      ).toBe("ready");
      expect(
        write("POST", "/v1/counterparties/demo_cpty_jane/requirements", {
          provider,
          direction: "offramp",
        })?.body.data.status
      ).toBe("ready");
    }
  });
});

/** A pair each provider runs on an asset the demo holds, from the support tables. */
function supportedPair(direction: "onramp" | "offramp", provider: RampProviderId) {
  const row =
    direction === "onramp"
      ? ONRAMP_SUPPORT.map(({ source, dest, providers }) => ({
          fiat: source,
          rail: dest,
          providers,
        }))
      : OFFRAMP_SUPPORT.map(({ source, dest, providers }) => ({
          fiat: dest,
          rail: source,
          providers,
        }));
  return row.find(
    (entry) =>
      (entry.providers as readonly string[]).includes(provider) && isDemoRampRail(entry.rail)
  );
}

describe("ramp assets", () => {
  it("holds every asset a demo ramp offers, and no other", () => {
    expect([...DEMO_RAMP_ASSETS].sort()).toEqual(
      Object.values(DEMO_TOKENS)
        .map((token) => token.symbol.toLowerCase())
        .sort()
    );
    for (const { dest } of ONRAMP_SUPPORT) {
      expect(isDemoRampRail(dest)).toBe(tokenKeyForRail(dest) !== undefined);
    }
    expect(tokenKeyForRail("pyusd.solana")).toBeUndefined();
    expect(tokenKeyForRail("sol.solana")).toBe("SOL");
  });

  it("leaves pairs for other assets out of the pickers in demo mode only", () => {
    const pairs = [{ assetRail: "usdc.solana" }, { assetRail: "usdt.solana" }];
    expect(demoRampPairs(pairs, true)).toEqual([{ assetRail: "usdc.solana" }]);
    expect(demoRampPairs(pairs, false)).toEqual(pairs);
  });

  it("estimates and quotes nothing for an asset the demo wallets don't hold", () => {
    const estimate = write("POST", "/v1/payments/ramps/onramp/estimate", {
      assetRail: "pyusd.solana",
      fiatCurrency: "USD",
      fiatAmount: "100",
    });
    expect(estimate?.body.data.estimates).toEqual([]);
    const onramp = write("POST", "/v1/payments/ramps/onramp/quote", {
      provider: "moonpay",
      counterpartyId: "demo_cpty_jane",
      destinationCustodyWalletId: TREASURY,
      assetRail: "pyusd.solana",
      fiatCurrency: "USD",
      fiatAmount: "100",
    });
    expect(onramp?.body.error.message).toMatch(/^The demo wallets don't hold PYUSD/);
    const offramp = write("POST", "/v1/payments/ramps/offramp/quote", {
      provider: "moonpay",
      counterpartyId: "demo_cpty_jane",
      sourceCustodyWalletId: TREASURY,
      assetRail: "usdt.solana",
      fiatCurrency: "USD",
      cryptoAmount: "10",
    });
    expect(offramp?.status).toBe(400);
    expect(ops).toEqual([]);
  });
});

describe("ramp estimates and quotes", () => {
  it("estimates an off-ramp from its crypto amount, and a blank amount as zero", () => {
    const offramp = write("POST", "/v1/payments/ramps/offramp/estimate", {
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      cryptoAmount: "100",
    });
    expect(offramp?.body.data.estimates.length).toBeGreaterThan(0);
    expect(offramp?.body.data.estimates[0].estimate.cryptoAmount).toBe("100.00");
    const blank = write("POST", "/v1/payments/ramps/onramp/estimate", {
      assetRail: "sol.solana",
      fiatCurrency: "AUD",
      fiatAmount: "lots",
    });
    for (const result of blank?.body.data.estimates ?? []) {
      expect(result.estimate.fiatAmount).toBe("0.00");
      expect(result.estimate.cryptoAmount).toBe("0.0000");
    }
    expect(write("POST", "/v1/payments/ramps/onramp/estimate", {})?.status).toBe(400);
  });

  it("refuses an on-ramp quote the API would", () => {
    const quote = (body: Record<string, unknown>) =>
      write("POST", "/v1/payments/ramps/onramp/quote", {
        provider: "moonpay",
        counterpartyId: "demo_cpty_jane",
        destinationCustodyWalletId: TREASURY,
        assetRail: "usdc.solana",
        fiatCurrency: "USD",
        fiatAmount: "100",
        ...body,
      });
    expect(quote({ provider: "acme" })?.status).toBe(400);
    expect(write("POST", "/v1/payments/ramps/onramp/quote", null)?.status).toBe(400);
    expect(quote({ fiatAmount: "0" })?.status).toBe(400);
    expect(quote({ counterpartyId: "demo_cpty_nobody" })?.status).toBe(404);
    expect(quote({ destinationCustodyWalletId: "demo_cwlt_nobody" })?.status).toBe(404);
    expect(quote({ fiatCurrency: "JPY" })?.body.error.message).toMatch(/doesn't run JPY to USDC/);
    expect(ops).toEqual([]);
  });

  it("quotes an on-ramp in each provider's own shape", () => {
    const modes: Record<string, string> = {};
    for (const provider of RAMP_PROVIDERS) {
      const pair = supportedPair("onramp", provider);
      if (!pair) continue;
      const quoted = write("POST", "/v1/payments/ramps/onramp/quote", {
        provider,
        counterpartyId: "demo_cpty_jane",
        destinationCustodyWalletId: TREASURY,
        assetRail: pair.rail,
        fiatCurrency: pair.fiat,
        fiatAmount: "200",
      });
      expect(quoted?.status, provider).toBe(201);
      modes[provider] = quoted?.body.data.quote.deliveryMode;
    }
    expect(modes).toEqual({
      moonpay: "hosted",
      stripe: "session_widget",
    });
  });

  it("refuses an off-ramp quote the API would", () => {
    const quote = (body: Record<string, unknown>) =>
      write("POST", "/v1/payments/ramps/offramp/quote", {
        provider: "moonpay",
        counterpartyId: "demo_cpty_jane",
        sourceCustodyWalletId: "demo_cwlt_settlement",
        assetRail: "sol.solana",
        fiatCurrency: "EUR",
        cryptoAmount: "1",
        ...body,
      });
    expect(quote({ cryptoAmount: "-1" })?.status).toBe(400);
    expect(quote({ counterpartyId: "demo_cpty_nobody" })?.status).toBe(404);
    expect(quote({ sourceCustodyWalletId: "demo_cwlt_nobody" })?.status).toBe(404);
    expect(quote({ fiatCurrency: "JPY" })?.body.error.message).toMatch(/doesn't run SOL to JPY/);
    expect(refusal(quote({ cryptoAmount: "999999" }))).toEqual([400, "insufficient_funds"]);
    expect(ops).toEqual([]);
  });

  it("quotes an off-ramp in each provider's own shape", () => {
    for (const provider of RAMP_PROVIDERS) {
      const pair = supportedPair("offramp", provider);
      if (!pair) continue;
      const quoted = write("POST", "/v1/payments/ramps/offramp/quote", {
        provider,
        counterpartyId: "demo_cpty_jane",
        sourceCustodyWalletId: TREASURY,
        assetRail: pair.rail,
        fiatCurrency: pair.fiat,
        cryptoAmount: "1",
      });
      expect(quoted?.status, provider).toBe(201);
      expect(quoted?.body.data.transferId).toMatch(/^demo_new_xfr_/);
    }
  });
});

describe("ramp pay-ins and cancels", () => {
  function deposit(counterpartyId = "demo_cpty_jane") {
    return write("POST", "/v1/payments/ramps/onramp/quote", {
      provider: "moonpay",
      counterpartyId,
      destinationCustodyWalletId: TREASURY,
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      fiatAmount: "100",
    })?.body.data as { transferId: string; quote: { id: string } };
  }
  const simulate = (body: Record<string, unknown>) =>
    write("POST", "/v1/payments/ramps/sandbox/simulate", body);

  it("pays a deposit by its transfer alone, as the API takes it", () => {
    expect(simulate({})?.status).toBe(400);
    expect(refusal(simulate({ transferId: "demo_xfr_nobody" }))).toEqual([404, "not_found"]);
    const { transferId } = deposit();
    expect(simulate({ transferId })?.status).toBe(204);
    expect(transferById(world(), transferId)?.status).toBe("settling");
  });

  it("refuses to pay a deposit twice by its transfer", () => {
    const { transferId } = deposit();
    expect(simulate({ transferId })?.status).toBe(204);
    expect(refusal(simulate({ transferId }))).toEqual([409, "conflict"]);
  });

  it("cancels only a deposit still waiting for its money", () => {
    expect(write("POST", "/v1/payments/ramps/transfers/cancel", {})?.status).toBe(400);
    expect(
      write("POST", "/v1/payments/ramps/transfers/cancel", { transferId: "demo_xfr_nobody" })
        ?.status
    ).toBe(404);
    const { transferId } = deposit();
    const canceled = write("POST", "/v1/payments/ramps/transfers/cancel", { transferId });
    expect(canceled?.body.data.transfer.status).toBe("canceled");
  });
});

describe("transfers and batches", () => {
  const send = (body: Record<string, unknown>) =>
    write("POST", "/v1/payments/transfers", {
      sourceCustodyWalletId: TREASURY,
      destination: ADDRESS,
      token: USDC,
      amount: "5",
      ...body,
    });

  it("refuses a transfer the API would", () => {
    expect(send({ destination: "nope" })?.status).toBe(400);
    expect(send({ sourceCustodyWalletId: "demo_cwlt_nobody" })?.status).toBe(404);
    expect(send({ destination: "9brFR8oxX8nHVrU3LiEGV1LZWyUPcKtjaHdvWAqU6sP8" })?.status).toBe(400);
    expect(send({ token: "MintThatTheDemoDoesNotHold111111111111111" })?.body.error.message).toBe(
      "The demo wallets don't hold that token."
    );
    expect(ops).toEqual([]);
  });

  it("keeps a demo transfer id, and answers a resend with the first transfer", () => {
    const first = send({ transferId: "demo_new_xfr_resend", memo: "rent" });
    expect(first?.body.data.transfer.id).toBe("demo_new_xfr_resend");
    const again = send({ transferId: "demo_new_xfr_resend" });
    expect(again?.status).toBe(200);
    expect(ops).toHaveLength(1);
    const fresh = send({ transferId: "client_supplied" });
    expect(fresh?.body.data.transfer.id).toMatch(/^demo_new_xfr_/);
  });

  it("funds an off-ramp's payout once, from a wallet that can cover it", () => {
    const quoted = write("POST", "/v1/payments/ramps/offramp/quote", {
      provider: "moonpay",
      counterpartyId: "demo_cpty_jane",
      sourceCustodyWalletId: "demo_cwlt_settlement",
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      cryptoAmount: "100",
    });
    const transferId: string = quoted?.body.data.transferId;
    expect(
      send({ transferId, sourceCustodyWalletId: "demo_cwlt_settlement", amount: "999999" })?.status
    ).toBe(400);
    expect(
      send({ transferId, sourceCustodyWalletId: "demo_cwlt_settlement", amount: "100" })?.status
    ).toBe(201);
    expect(
      refusal(send({ transferId, sourceCustodyWalletId: "demo_cwlt_settlement", amount: "100" }))
    ).toEqual([409, "conflict"]);
  });

  it("refuses a batch the API would", () => {
    const batch = (body: Record<string, unknown>) =>
      write("POST", "/v1/payments/transfer-batches", {
        sourceCustodyWalletId: "demo_cwlt_payroll",
        token: USDC,
        recipients: [
          { counterpartyId: "demo_cpty_kai", counterpartyAccountId: "demo_cpa_kai", amount: "1" },
        ],
        ...body,
      });
    expect(batch({ recipients: [] })?.status).toBe(400);
    expect(write("POST", "/v1/payments/transfer-batches/estimate", {})?.status).toBe(400);
    expect(batch({ sourceCustodyWalletId: "demo_cwlt_nobody" })?.status).toBe(404);
    expect(
      batch({
        recipients: [
          { counterpartyId: "demo_cpty_kai", counterpartyAccountId: "demo_cpa_jane", amount: "1" },
        ],
      })?.status
    ).toBe(400);
    expect(
      refusal(
        batch({
          recipients: [
            {
              counterpartyId: "demo_cpty_kai",
              counterpartyAccountId: "demo_cpa_kai",
              amount: "9999999",
            },
          ],
        })
      )
    ).toEqual([400, "insufficient_funds"]);
    expect(
      write("POST", "/v1/payments/transfer-batches/estimate", {
        sourceCustodyWalletId: "demo_cwlt_nobody",
        token: USDC,
        recipients: [
          { counterpartyId: "demo_cpty_kai", counterpartyAccountId: "demo_cpa_kai", amount: "1" },
        ],
      })?.status
    ).toBe(404);
    expect(batch({ externalId: "RUN-1" })?.status).toBe(201);
  });
});

describe("requests", () => {
  const request = (body: Record<string, unknown>) =>
    write("POST", "/v1/payments/requests", {
      walletId: TREASURY,
      token: USDC,
      amount: "40",
      ...body,
    });

  it("refuses a request the API would", () => {
    expect(request({ amount: "" })?.status).toBe(400);
    expect(request({ walletId: "demo_cwlt_nobody" })?.status).toBe(404);
    expect(request({ counterpartyId: "demo_cpty_nobody" })?.status).toBe(404);
    expect(request({ expiresAt: "2026-09-01T00:00:00.000Z" })?.status).toBe(400);
    expect(request({ expiresAt: "not a date" })?.status).toBe(400);
    expect(ops).toEqual([]);
  });

  it("creates one for a contact, with an expiry", () => {
    const created = request({
      counterpartyId: "demo_cpty_acme",
      expiresAt: "2026-10-28T00:00:00.000Z",
    });
    expect(created?.status).toBe(201);
    expect(created?.body.data).toEqual(
      expect.objectContaining({
        counterpartyId: "demo_cpty_acme",
        expiresAt: "2026-10-28T00:00:00.000Z",
      })
    );
  });
});

describe("schedules", () => {
  const create = (body: Record<string, unknown>) =>
    write("POST", "/v1/payments/recurring-payments", {
      sourceCustodyWalletId: TREASURY,
      counterpartyId: "demo_cpty_jane",
      counterpartyAccountId: "demo_cpa_jane",
      token: USDC,
      amount: "10",
      periodHours: 24,
      ...body,
    });
  const update = (id: string, body: Record<string, unknown>) =>
    write("PATCH", `/v1/payments/recurring-payments/${id}`, body);
  const act = (id: string, action: string) =>
    write("POST", `/v1/payments/recurring-payments/${id}/${action}`);

  it("refuses a schedule the API would", () => {
    expect(create({ periodHours: 0 })?.status).toBe(400);
    expect(create({ sourceCustodyWalletId: "demo_cwlt_nobody" })?.status).toBe(404);
    expect(create({ counterpartyAccountId: "demo_cpa_kai" })?.status).toBe(400);
    expect(create({ counterpartyAccountId: "demo_cpa_nobody" })?.status).toBe(400);
    expect(create({ firstCollectionAt: "2026-09-01T00:00:00.000Z" })?.status).toBe(400);
    expect(create({ firstCollectionAt: "2026-10-01T00:00:00.000Z" })?.status).toBe(201);
  });

  it("refuses a change the API would, and applies every field it accepts", () => {
    expect(update("demo_rp_nobody", {})?.status).toBe(404);
    expect(refusal(update("demo_rp_jane_stipend", {}))).toEqual([409, "conflict"]);
    expect(update("demo_rp_lumen_retainer", { periodHours: 99999 })?.status).toBe(400);
    expect(
      update("demo_rp_lumen_retainer", { sourceCustodyWalletId: "demo_cwlt_nobody" })?.status
    ).toBe(404);
    expect(
      update("demo_rp_lumen_retainer", { counterpartyAccountId: "demo_cpa_kai" })?.status
    ).toBe(400);
    expect(ops).toEqual([]);
    const changed = update("demo_rp_lumen_retainer", {
      amount: "12.5",
      token: USDC,
      periodHours: 48,
      sourceCustodyWalletId: "demo_cwlt_settlement",
      counterpartyAccountId: "demo_cpa_lumen",
    });
    expect(changed?.status).toBe(200);
    expect(ops[0]).toEqual(
      expect.objectContaining({
        k: "schedule-update",
        amount: "12.5",
        period: 48,
        wallet: "demo_cwlt_settlement",
        account: "demo_cpa_lumen",
      })
    );
    update("demo_rp_lumen_retainer", {});
    expect(Object.keys(ops[1] ?? {}).sort()).toEqual(["at", "id", "k"]);
  });

  it("refuses an action the schedule's status doesn't allow", () => {
    expect(act("demo_rp_nobody", "activate")?.status).toBe(404);
    expect(act("demo_rp_lumen_retainer", "explode")?.status).toBe(404);
    expect(act("demo_rp_lumen_retainer", "activate")?.status).toBe(409);
    expect(act("demo_rp_northwind_supply", "collect")?.status).toBe(409);
    expect(act("demo_rp_lumen_retainer", "collect")?.body.error.message).toBe(
      "The next run isn't due yet."
    );
    expect(act("demo_rp_jane_stipend", "cancel")?.status).toBe(409);
    expect(act("demo_rp_lumen_retainer", "resume")?.status).toBe(409);
    expect(act("demo_rp_northwind_supply", "cancel")?.status).toBe(200);
    // Canceled before it ever ran, so there is nothing to resume.
    expect(act("demo_rp_northwind_supply", "resume")?.status).toBe(409);
  });
});
