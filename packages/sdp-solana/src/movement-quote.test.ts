import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TokenMovementBasis } from "@sdp/types/token-movements";
import { type Address, getAddressDecoder, unixTimestamp } from "@solana/kit";
import { AmountError } from "./amount";
import { NATIVE_ASSET, type TokenAsset } from "./asset-ref";
import { quoteMovement } from "./movement-quote";
import { baseUnits, parseTokenAmount } from "./token-amount";
import {
  type DisplayRule,
  type MintTokenTerms,
  NATIVE_TOKEN_TERMS,
  type TransferFeeRate,
} from "./token-terms";

const testAddress = (byte: number): Address =>
  getAddressDecoder().decode(new Uint8Array(32).fill(byte));

const ASSET: TokenAsset = { kind: "token", mint: testAddress(1), program: "token-2022" };
const READ_AT = { slot: 900n, unixTimestamp: unixTimestamp(1_800_000_000n), epoch: 700n };

const rate = (epoch: bigint, basisPoints: number, maximumFee: bigint): TransferFeeRate => ({
  epoch,
  basisPoints,
  maximumFee: baseUnits(maximumFee),
});

function mintTerms(
  transferFee: MintTokenTerms["transferFee"],
  display: DisplayRule
): MintTokenTerms {
  return {
    asset: ASSET,
    decimals: 6,
    readAt: READ_AT,
    transferFee,
    display,
    transferHookProgram: null,
    transferHookAuthority: null,
    paused: false,
    nonTransferable: false,
    defaultAccountState: "initialized",
    permanentDelegate: null,
    confidentialTransfers: false,
    mintCloseAuthority: null,
    freezeAuthority: null,
    requiredAccountExtensions: [],
  };
}

const PLAIN: DisplayRule = { kind: "plain" };
const FIFTY_BPS = rate(0n, 50, 5_000n);

function intent(amount: string, basis: TokenMovementBasis) {
  return { asset: ASSET, amount: parseTokenAmount(amount, 6), basis };
}

describe("quoteMovement", () => {
  it("moves native SOL one to one, with static terms", () => {
    const quote = quoteMovement(NATIVE_TOKEN_TERMS, {
      asset: NATIVE_ASSET,
      amount: parseTokenAmount("1.5", 9),
      basis: "credit",
    });
    assert.equal(quote.debit, 1_500_000_000n);
    assert.equal(quote.fee, 0n);
    assert.equal(quote.credit, 1_500_000_000n);
    assert.equal(quote.decimals, 9);
    assert.equal(quote.feeEpoch, null);
    assert.equal(quote.display, null);
    assert.equal(quote.asOf, null);
  });

  it("moves a mint without a fee config one to one, at the read", () => {
    const quote = quoteMovement(mintTerms(null, PLAIN), intent("2", "debit"));
    assert.deepEqual(
      { debit: quote.debit, fee: quote.fee, credit: quote.credit, feeEpoch: quote.feeEpoch },
      { debit: 2_000_000n, fee: 0n, credit: 2_000_000n, feeEpoch: null }
    );
    assert.deepEqual(quote.asOf, READ_AT);
  });

  it("prices a zero fee config, the PYUSD case, at the read's epoch", () => {
    const zero = rate(0n, 0, 0n);
    const quote = quoteMovement(
      mintTerms({ older: zero, newer: zero }, PLAIN),
      intent("10", "debit")
    );
    assert.equal(quote.fee, 0n);
    assert.equal(quote.credit, 10_000_000n);
    assert.equal(quote.feeEpoch, 700n);
  });

  it("splits a debit into credit and fee", () => {
    const terms = mintTerms({ older: FIFTY_BPS, newer: FIFTY_BPS }, PLAIN);
    const quote = quoteMovement(terms, intent("1", "debit"));
    assert.deepEqual(
      { debit: quote.debit, fee: quote.fee, credit: quote.credit },
      { debit: 1_000_000n, fee: 5_000n, credit: 995_000n }
    );
    const capped = quoteMovement(terms, intent("100", "debit"));
    assert.deepEqual(
      { debit: capped.debit, fee: capped.fee, credit: capped.credit },
      { debit: 100_000_000n, fee: 5_000n, credit: 99_995_000n }
    );
  });

  it("grosses a credit up to the smallest debit that delivers it", () => {
    const terms = mintTerms({ older: FIFTY_BPS, newer: FIFTY_BPS }, PLAIN);
    const quote = quoteMovement(terms, intent("0.995", "credit"));
    assert.deepEqual(
      { debit: quote.debit, fee: quote.fee, credit: quote.credit },
      { debit: 1_000_000n, fee: 5_000n, credit: 995_000n }
    );
    assert.equal(quote.debit, quote.credit + quote.fee);
  });

  it("prices with the fee entry of the read's epoch", () => {
    const pending = mintTerms({ older: FIFTY_BPS, newer: rate(701n, 100, 5_000n) }, PLAIN);
    assert.equal(quoteMovement(pending, intent("1", "debit")).fee, 5_000n);
    const effective = mintTerms({ older: FIFTY_BPS, newer: rate(700n, 100, 50_000n) }, PLAIN);
    assert.equal(quoteMovement(effective, intent("1", "debit")).fee, 10_000n);
  });

  it("adds display values for a scaled mint", () => {
    const terms = mintTerms(
      { older: FIFTY_BPS, newer: FIFTY_BPS },
      {
        kind: "scaled",
        multiplier: 1.5,
        newMultiplier: 1.5,
        newMultiplierEffectiveAt: unixTimestamp(0n),
      }
    );
    const quote = quoteMovement(terms, intent("1", "debit"));
    assert.deepEqual(
      quote.display && {
        debit: quote.display.debit.value,
        fee: quote.display.fee.value,
        credit: quote.display.credit.value,
        asOf: quote.display.debit.asOf,
      },
      { debit: "1.5", fee: "0.0075", credit: "1.4925", asOf: READ_AT.unixTimestamp }
    );
  });

  it("refuses an amount at another scale than the mint", () => {
    assert.throws(
      () =>
        quoteMovement(mintTerms(null, PLAIN), {
          asset: ASSET,
          amount: parseTokenAmount("1", 9),
          basis: "debit",
        }),
      AmountError
    );
  });

  it("refuses terms read for another asset", () => {
    assert.throws(
      () => quoteMovement(mintTerms(null, PLAIN), { ...intent("1", "debit"), asset: NATIVE_ASSET }),
      /different asset/
    );
    assert.throws(
      () =>
        quoteMovement(mintTerms(null, PLAIN), {
          ...intent("1", "debit"),
          asset: { ...ASSET, program: "spl-token" },
        }),
      /different asset/
    );
  });

  it("refuses a credit no u64 debit delivers", () => {
    const terms = mintTerms({ older: FIFTY_BPS, newer: FIFTY_BPS }, PLAIN);
    assert.throws(
      () => quoteMovement(terms, intent("18446744073709.551615", "credit")),
      AmountError
    );
  });
});
