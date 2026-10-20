import { rampAmountOutOfRange } from "@sdp/payments/errors";
import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { installClusterRpcStub, tokenAccountsByOwnerResult } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import {
  DEVNET_USDC_MINT,
  installPaymentsRouteTestHooks,
  seedCounterparty,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
} from "@/test/helpers/payments-routes";
import { readErrorResponse } from "@/test/helpers/payments-transfers";

function requestOfframpQuote(fields: {
  counterpartyId: string;
  assetRail: "usdc.solana" | "sol.solana";
  cryptoAmount: string;
  fiatCurrency?: "USD";
}) {
  return app.request(
    "/v1/payments/ramps/offramp/quote",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
      },
      body: JSON.stringify({
        provider: "moonpay",
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        ...fields,
      }),
    },
    env
  );
}

async function readCounterpartySales(counterpartyId: string) {
  const { results } = await getDb(env)
    .prepare(
      `SELECT status, amount, fiat_amount, fiat_currency
         FROM payment_transfers
        WHERE organization_id = ? AND counterparty_id = ?`
    )
    .bind(TEST_ORG.id, counterpartyId)
    .all<{
      status: string;
      amount: string | null;
      fiat_amount: string | null;
      fiat_currency: string | null;
    }>();
  return results;
}

/** MoonPay's sell estimate for the test, quoting `fiatAmount` or refusing with `refusal`. */
function estimateAnswers(answer: { fiatAmount: string } | { refusal: Error }) {
  const estimate = vi
    .spyOn(RAMP_PROVIDER_CLIENTS.moonpay, "estimateOfframp")
    .mockImplementation(async (_context, input) => {
      if ("refusal" in answer) throw answer.refusal;
      return {
        provider: "moonpay",
        direction: "offramp",
        fiatCurrency: input.fiatCurrency,
        assetRail: input.assetRail,
        fiatAmount: answer.fiatAmount,
        cryptoAmount: input.cryptoAmount,
        exchangeRate: "0.9873727923981503",
        fees: { currency: input.fiatCurrency, total: "3.99", provider: "3.99" },
      };
    });
  onTestFinished(() => estimate.mockRestore());
  return estimate;
}

const UNDER_MINIMUM = () =>
  rampAmountOutOfRange("amount_below_minimum", { amount: "19.92405", currency: "USDC" });

describe("Payments routes: off-ramp quote checks before the sale", () => {
  installPaymentsRouteTestHooks();
  const rpc = installClusterRpcStub();

  function walletHoldsUsdc(baseUnits: string) {
    rpc.answer(
      "getTokenAccountsByOwner",
      tokenAccountsByOwnerResult(1, [
        {
          pubkey: TEST_SOLANA_ADDRESSES.wallet3,
          mint: DEVNET_USDC_MINT,
          amount: baseUnits,
          decimals: 6,
          uiAmountString: String(Number(baseUnits) / 1_000_000),
          state: "initialized",
        },
      ])
    );
  }

  function chainReads(): string[] {
    return rpc.calls.map((call) => call.method).filter((method) => method !== "getGenesisHash");
  }

  it("stores MoonPay's quoted payout with the sale, after one balance read", async () => {
    const counterpartyId = await seedCounterparty();
    estimateAnswers({ fiatAmount: "20.69" });
    walletHoldsUsdc("25000000");

    const response = await requestOfframpQuote({
      counterpartyId,
      assetRail: "usdc.solana",
      cryptoAmount: "25",
      fiatCurrency: "USD",
    });

    expect(response.status).toBe(200);
    expect(await readCounterpartySales(counterpartyId)).toEqual([
      { status: "pending", amount: "25", fiat_amount: "20.69", fiat_currency: "USD" },
    ]);
    expect(chainReads()).toEqual(["getTokenAccountsByOwner"]);
  });

  it("refuses a sale under MoonPay's minimum with the minimum, writing no sale", async () => {
    const counterpartyId = await seedCounterparty();
    estimateAnswers({ refusal: UNDER_MINIMUM() });
    walletHoldsUsdc("25000000");

    const response = await requestOfframpQuote({
      counterpartyId,
      assetRail: "usdc.solana",
      cryptoAmount: "5",
    });

    expect(response.status).toBe(400);
    expect((await readErrorResponse(response)).error).toEqual({
      code: "BAD_REQUEST",
      message: "Amount is below this provider's minimum of 19.92405 USDC",
      details: {
        reason: "amount_below_minimum",
        limit: { amount: "19.92405", currency: "USDC" },
      },
    });
    expect(await readCounterpartySales(counterpartyId)).toEqual([]);
  });

  it("refuses a sale the wallet cannot fund, writing no sale", async () => {
    const counterpartyId = await seedCounterparty();
    estimateAnswers({ fiatAmount: "20.69" });
    walletHoldsUsdc("5000000");

    const response = await requestOfframpQuote({
      counterpartyId,
      assetRail: "usdc.solana",
      cryptoAmount: "25",
    });

    expect(response.status).toBe(400);
    expect((await readErrorResponse(response)).error).toMatchObject({
      code: "INSUFFICIENT_TOKEN_BALANCE",
      message: "Source wallet holds 5 USDC; this sale needs 25 USDC",
      details: { held: "5", needed: "25" },
    });
    expect(await readCounterpartySales(counterpartyId)).toEqual([]);
  });

  it("refuses an amount finer than USDC's precision, writing no sale", async () => {
    const counterpartyId = await seedCounterparty();
    estimateAnswers({ fiatAmount: "20.69" });
    walletHoldsUsdc("25000000");

    const response = await requestOfframpQuote({
      counterpartyId,
      assetRail: "usdc.solana",
      cryptoAmount: "25.0000001",
    });

    expect(response.status).toBe(400);
    expect((await readErrorResponse(response)).error).toMatchObject({
      code: "BAD_REQUEST",
      message: "Amount has too many decimal places: USDC allows 6",
    });
    expect(await readCounterpartySales(counterpartyId)).toEqual([]);
    expect(chainReads()).toEqual([]);
  });

  it("names the minimum first when the sale is both under it and unfunded", async () => {
    const counterpartyId = await seedCounterparty();
    estimateAnswers({ refusal: UNDER_MINIMUM() });
    walletHoldsUsdc("0");

    const response = await requestOfframpQuote({
      counterpartyId,
      assetRail: "usdc.solana",
      cryptoAmount: "5",
    });

    expect(response.status).toBe(400);
    expect((await readErrorResponse(response)).error).toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "amount_below_minimum" },
    });
  });

  it("reads a SOL sale's balance with one getBalance and quotes in USD by default", async () => {
    const counterpartyId = await seedCounterparty();
    const estimate = estimateAnswers({ fiatAmount: "140.12" });
    rpc.answer("getBalance", { context: { slot: 1 }, value: 2_000_000_000 });

    const response = await requestOfframpQuote({
      counterpartyId,
      assetRail: "sol.solana",
      cryptoAmount: "1.5",
    });

    expect(response.status).toBe(200);
    expect(estimate).toHaveBeenCalledWith(expect.anything(), {
      assetRail: "sol.solana",
      fiatCurrency: "USD",
      cryptoAmount: "1.5",
    });
    expect(await readCounterpartySales(counterpartyId)).toEqual([
      { status: "pending", amount: "1.5", fiat_amount: "140.12", fiat_currency: "USD" },
    ]);
    expect(chainReads()).toEqual(["getBalance"]);
  });
});
