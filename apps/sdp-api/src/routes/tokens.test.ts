import type { TokenAmountQuote, TokenTermsSummary } from "@sdp/types/token-movements";
import { type Address, getAddressDecoder } from "@solana/kit";
import { SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import type { ExtensionArgs } from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import { app } from "@/index";
import { installClusterRpcResponder } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { installPaymentsRouteTestHooks, TEST_API_KEY } from "@/test/helpers/payments-routes";
import {
  answerMovementAccounts,
  mintRpcAccount,
  TEST_CLOCK,
  transferFeeExtension,
} from "@/test/helpers/token-movement";

const testAddress = (byte: number): Address =>
  getAddressDecoder().decode(new Uint8Array(32).fill(byte));

const AUTHORITY = testAddress(2);
const CLASSIC_MINT = testAddress(11);
const FEE_MINT = testAddress(12);
const SCALED_MINT = testAddress(13);
const PAUSED_MINT = testAddress(14);
const READ_AT = new Date(Number(TEST_CLOCK.unixTimestamp) * 1000).toISOString();
const chainTime = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();

/** A 1.5× scaled mint whose multiplier switches to 2× 30 seconds after the Clock read. */
const pendingSwitch: ExtensionArgs = {
  __kind: "ScaledUiAmountConfig",
  authority: AUTHORITY,
  multiplier: 1.5,
  newMultiplierEffectiveTimestamp: TEST_CLOCK.unixTimestamp + 30n,
  newMultiplier: 2,
};

describe("token terms and quote routes", () => {
  installPaymentsRouteTestHooks();
  const rpc = installClusterRpcResponder();

  function answerMints() {
    answerMovementAccounts(
      rpc,
      new Map([
        [CLASSIC_MINT, mintRpcAccount("spl-token", { decimals: 6, extensions: null })],
        [
          FEE_MINT,
          mintRpcAccount("token-2022", {
            decimals: 6,
            extensions: [transferFeeExtension(50, 1_000_000n)],
          }),
        ],
        [SCALED_MINT, mintRpcAccount("token-2022", { decimals: 6, extensions: [pendingSwitch] })],
        [
          PAUSED_MINT,
          mintRpcAccount("token-2022", {
            decimals: 6,
            extensions: [{ __kind: "PausableConfig", authority: AUTHORITY, paused: true }],
          }),
        ],
      ])
    );
  }

  function getTerms(mint: string, environment = env) {
    return app.request(
      `/v1/tokens/${mint}/terms`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      environment
    );
  }

  function postQuote(mint: string, body: Record<string, string>) {
    return app.request(
      `/v1/tokens/${mint}/quote`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      env
    );
  }

  const termsReads = () => rpc.requests.filter(({ method }) => method === "getMultipleAccounts");

  async function termsOf(response: Response): Promise<TokenTermsSummary> {
    expect(response.status).toBe(200);
    const body: { data: { terms: TokenTermsSummary } } = await response.json();
    return body.data.terms;
  }

  async function quoteOf(response: Response): Promise<TokenAmountQuote> {
    expect(response.status).toBe(200);
    const body: { data: { quote: TokenAmountQuote } } = await response.json();
    return body.data.quote;
  }

  it("reads a fee mint's terms in one request, with this epoch's and the next epoch's fee", async () => {
    answerMints();

    const terms = await termsOf(await getTerms(FEE_MINT));

    expect(terms).toMatchObject({
      mint: FEE_MINT,
      program: "token-2022",
      decimals: 6,
      readAt: { slot: "4200", epoch: "900", time: READ_AT },
      transferFee: {
        current: { epoch: "0", basisPoints: 50, maximumFee: "1" },
        next: { epoch: "0", basisPoints: 50, maximumFee: "1" },
      },
      display: { rule: "plain" },
      paused: false,
      transferHookProgram: null,
    });
    expect(terms.support.find(({ path }) => path === "builder")).toEqual({
      path: "builder",
      supported: true,
      refusals: [],
    });
    expect(terms.support.find(({ path }) => path === "private_channels")).toMatchObject({
      supported: false,
      refusals: [{ reason: "transfer_fee", extension: "TransferFeeConfig", disposition: "refuse" }],
    });
    // RPC budget: one getMultipleAccounts for the mint and the Clock.
    expect(termsReads()).toHaveLength(1);
    expect(termsReads()[0]?.params[0]).toEqual([FEE_MINT, SYSVAR_CLOCK_ADDRESS]);
  });

  it("reports a paused mint refused by the builder and held by recurring pulls", async () => {
    answerMints();

    const terms = await termsOf(await getTerms(PAUSED_MINT));

    expect(terms.paused).toBe(true);
    expect(terms.support.find(({ path }) => path === "builder")).toMatchObject({
      supported: false,
      refusals: [{ reason: "paused", disposition: "refuse" }],
    });
    expect(terms.support.find(({ path }) => path === "recurring")).toMatchObject({
      supported: false,
      refusals: [{ reason: "paused", disposition: "hold" }],
    });
  });

  it("names only the paths of modules the release channel runs, and no Earn path while it is held", async () => {
    answerMints();

    const experimental = await termsOf(await getTerms(CLASSIC_MINT));
    const stable = await termsOf(
      await getTerms(CLASSIC_MINT, { ...env, SDP_RELEASE_CHANNEL: "stable" })
    );

    expect(experimental.support.map(({ path }) => path)).toEqual([
      "builder",
      "recurring",
      "issuance",
      "issuance_seize",
      "dvp",
      "private_channels",
    ]);
    expect(stable.support.map(({ path }) => path)).toEqual(["builder", "recurring"]);
  });

  it("refuses an address that holds no mint", async () => {
    answerMints();

    const response = await getTerms(testAddress(99));

    expect(response.status).toBe(400);
  });

  it("quotes a debit on a fee mint as debit, fee and credit in token units", async () => {
    answerMints();

    const quote = await quoteOf(await postQuote(FEE_MINT, { amount: "100" }));

    expect(quote).toEqual({
      mint: FEE_MINT,
      amount: "100",
      // 0.5% of 100, capped at 1.
      amounts: { basis: "debit", debit: "100", fee: "0.5", credit: "99.5", decimals: 6 },
      feeEpoch: "900",
      asOf: READ_AT,
      expiresAt: chainTime(TEST_CLOCK.unixTimestamp + 60n),
    });
  });

  it("grosses a credit up to the debit that delivers it exactly", async () => {
    answerMints();

    const quote = await quoteOf(await postQuote(FEE_MINT, { amount: "99.5", basis: "credit" }));

    expect(quote.amounts).toMatchObject({ debit: "100", fee: "0.5", credit: "99.5" });
  });

  it("converts a display amount to the token amount to send, and expires at a pending multiplier switch", async () => {
    answerMints();

    const quote = await quoteOf(await postQuote(SCALED_MINT, { displayAmount: "150" }));

    expect(quote).toMatchObject({
      mint: SCALED_MINT,
      // 150 shown at 1.5× is 100 tokens.
      amount: "100",
      amounts: {
        basis: "debit",
        debit: "100",
        fee: "0",
        credit: "100",
        display: { debit: "150", fee: "0", credit: "150", asOf: READ_AT },
      },
      feeEpoch: null,
      expiresAt: chainTime(TEST_CLOCK.unixTimestamp + 30n),
    });
  });

  it("never debits more than the display amount typed, nor credits less", async () => {
    answerMints();

    // 0.000001 tokens show as 0.0000015 → truncated to 0.000001 at 6 decimals.
    const debit = await quoteOf(await postQuote(SCALED_MINT, { displayAmount: "1.0000005" }));
    const credit = await quoteOf(
      await postQuote(SCALED_MINT, { displayAmount: "1.0000005", basis: "credit" })
    );

    expect(Number(debit.amounts.display?.debit)).toBeLessThanOrEqual(1.0000005);
    expect(Number(credit.amounts.display?.credit)).toBeGreaterThanOrEqual(1.0000005);
  });

  it.for<{ label: string; body: Record<string, string> }>([
    { label: "both amounts", body: { amount: "1", displayAmount: "1" } },
    { label: "no amount", body: {} },
    { label: "a zero amount", body: { amount: "0" } },
    { label: "an amount finer than the mint", body: { amount: "0.0000001" } },
  ])("refuses $label with 400", async ({ body }) => {
    answerMints();

    const response = await postQuote(FEE_MINT, body);

    expect(response.status).toBe(400);
  });
});
