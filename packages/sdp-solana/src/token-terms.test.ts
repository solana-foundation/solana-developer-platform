import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import {
  type Address,
  address,
  type EncodedAccount,
  getAddressDecoder,
  lamports,
  type ReadonlyUint8Array,
  unixTimestamp,
} from "@solana/kit";
import { getSysvarClockEncoder, SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import {
  AccountState,
  type ExtensionArgs,
  getMintEncoder,
  getTokenEncoder,
  getTokenSize,
} from "@solana-program/token-2022";
import { AmountError } from "./amount";
import { seededRandom } from "./test/seeded-random";
import { baseUnits, U64_MAX } from "./token-amount";
import {
  type DisplayRule,
  debitForCredit,
  decodeTokenTerms,
  epochFee,
  feeFor,
  type MintTokenTerms,
  NATIVE_TOKEN_TERMS,
  TOKEN_TERMS_REFUSALS,
  TokenTermsError,
  toDisplay,
} from "./token-terms";

const testAddress = (byte: number): Address =>
  getAddressDecoder().decode(new Uint8Array(32).fill(byte));

const MINT = testAddress(1);
const AUTHORITY = testAddress(2);
const HOOK_PROGRAM = testAddress(3);
const UNSET = address("11111111111111111111111111111111");
const SPL_TOKEN = address(SPL_TOKEN_PROGRAMS["spl-token"]);
const TOKEN_2022 = address(SPL_TOKEN_PROGRAMS["token-2022"]);

/** `INT_SECONDS_PER_YEAR` in the program's tests. */
const SECONDS_PER_YEAR = 31_556_736n;

const READ_AT = { slot: 284_617_079n, unixTimestamp: unixTimestamp(1_800_000_000n), epoch: 700n };

function account(
  address: Address,
  programAddress: Address,
  data: ReadonlyUint8Array
): EncodedAccount {
  return { address, data, executable: false, lamports: lamports(1n), programAddress, space: 0n };
}

function clockAccount(): EncodedAccount {
  const data = getSysvarClockEncoder().encode({
    slot: READ_AT.slot,
    epochStartTimestamp: unixTimestamp(1_799_990_000n),
    epoch: READ_AT.epoch,
    leaderScheduleEpoch: READ_AT.epoch + 1n,
    unixTimestamp: READ_AT.unixTimestamp,
  });
  return account(
    SYSVAR_CLOCK_ADDRESS,
    address("Sysvar1111111111111111111111111111111111111"),
    data
  );
}

function mintData(extensions: ExtensionArgs[] | null, isInitialized: boolean) {
  return getMintEncoder().encode({
    mintAuthority: AUTHORITY,
    supply: 1_000_000n,
    decimals: 6,
    isInitialized,
    freezeAuthority: AUTHORITY,
    extensions,
  });
}

/** An initialized 6-decimal mint owned by `programAddress`. */
function mintOwnedBy(programAddress: Address, extensions: ExtensionArgs[] | null): EncodedAccount {
  return account(MINT, programAddress, mintData(extensions, true));
}

/** An initialized 6-decimal Token-2022 mint. */
function mintAccount(extensions: ExtensionArgs[] | null): EncodedAccount {
  return mintOwnedBy(TOKEN_2022, extensions);
}

function decode(mint: EncodedAccount) {
  return decodeTokenTerms({ kind: "mint", mint: MINT }, { mint, clock: clockAccount() });
}

function refusal(reason: string) {
  return (error: unknown) => error instanceof TokenTermsError && error.reason === reason;
}

const transferFeeConfig = (
  older: { epoch: bigint; bps: number; max: bigint },
  newer: { epoch: bigint; bps: number; max: bigint }
): ExtensionArgs => ({
  __kind: "TransferFeeConfig",
  transferFeeConfigAuthority: AUTHORITY,
  withdrawWithheldAuthority: AUTHORITY,
  withheldAmount: 0n,
  olderTransferFee: {
    epoch: older.epoch,
    maximumFee: older.max,
    transferFeeBasisPoints: older.bps,
  },
  newerTransferFee: {
    epoch: newer.epoch,
    maximumFee: newer.max,
    transferFeeBasisPoints: newer.bps,
  },
});

/** Terms for the pure rules: a Token-2022 mint with only the given fee and display. */
function termsWith(fields: {
  fee: { bps: number; max: bigint } | null;
  display: DisplayRule;
  decimals: number;
}): MintTokenTerms {
  const { fee } = fields;
  const rate = fee && { epoch: 0n, basisPoints: fee.bps, maximumFee: baseUnits(fee.max) };
  return {
    ...decode(mintAccount(null)),
    decimals: fields.decimals,
    transferFee: rate && { older: rate, newer: rate },
    display: fields.display,
  };
}

const PLAIN: DisplayRule = { kind: "plain" };

/** A 6-decimal mint with one fee entry for every epoch and plain display. */
const feeTerms = (bps: number, max: bigint) =>
  termsWith({ fee: { bps, max }, display: PLAIN, decimals: 6 });

/** A mint with no fee config and the given display rule. */
const displayTerms = (display: DisplayRule, decimals: number) =>
  termsWith({ fee: null, display, decimals });

describe("decodeTokenTerms", () => {
  it("decodes a classic SPL mint", () => {
    const terms = decodeTokenTerms(
      { kind: "token", mint: MINT, program: "spl-token" },
      { mint: mintOwnedBy(SPL_TOKEN, null), clock: clockAccount() }
    );
    assert.deepEqual(terms, {
      asset: { kind: "token", mint: MINT, program: "spl-token" },
      decimals: 6,
      readAt: READ_AT,
      freezeAuthority: AUTHORITY,
      transferFee: null,
      display: { kind: "plain" },
      transferHookProgram: null,
      paused: false,
      nonTransferable: false,
      defaultAccountState: "initialized",
      permanentDelegate: null,
      confidentialTransfers: false,
      mintCloseAuthority: null,
      requiredAccountExtensions: [],
    });
  });

  it("decodes a PYUSD-like mint: a zero fee, an unset hook and the other extensions", () => {
    const terms = decode(
      mintAccount([
        transferFeeConfig({ epoch: 0n, bps: 0, max: 0n }, { epoch: 0n, bps: 0, max: 0n }),
        { __kind: "TransferHook", authority: AUTHORITY, programId: UNSET },
        { __kind: "PermanentDelegate", delegate: AUTHORITY },
        {
          __kind: "ConfidentialTransferMint",
          authority: AUTHORITY,
          autoApproveNewAccounts: false,
          auditorElgamalPubkey: null,
        },
        { __kind: "MintCloseAuthority", closeAuthority: AUTHORITY },
        { __kind: "MetadataPointer", authority: AUTHORITY, metadataAddress: MINT },
      ])
    );
    const zero = { epoch: 0n, basisPoints: 0, maximumFee: 0n };
    assert.deepEqual(terms.transferFee, { older: zero, newer: zero });
    assert.equal(terms.transferHookProgram, null);
    assert.equal(terms.permanentDelegate, AUTHORITY);
    assert.equal(terms.confidentialTransfers, true);
    assert.equal(terms.mintCloseAuthority, AUTHORITY);
    assert.deepEqual(
      terms.requiredAccountExtensions.map((extension) => extension.__kind),
      ["TransferFeeAmount", "TransferHookAccount"]
    );
  });

  it("decodes the fee schedule, hook, pause and account rules", () => {
    const terms = decode(
      mintAccount([
        transferFeeConfig({ epoch: 10n, bps: 50, max: 5_000n }, { epoch: 12n, bps: 100, max: 9n }),
        { __kind: "TransferHook", authority: AUTHORITY, programId: HOOK_PROGRAM },
        { __kind: "PausableConfig", authority: AUTHORITY, paused: true },
        { __kind: "DefaultAccountState", state: AccountState.Frozen },
        { __kind: "NonTransferable" },
      ])
    );
    assert.deepEqual(terms.transferFee, {
      older: { epoch: 10n, basisPoints: 50, maximumFee: 5_000n },
      newer: { epoch: 12n, basisPoints: 100, maximumFee: 9n },
    });
    assert.equal(terms.transferHookProgram, HOOK_PROGRAM);
    assert.equal(terms.paused, true);
    assert.equal(terms.defaultAccountState, "frozen");
    assert.equal(terms.nonTransferable, true);
    const required = [...terms.requiredAccountExtensions];
    assert.deepEqual(
      required.map((extension) => extension.__kind),
      [
        "TransferFeeAmount",
        "TransferHookAccount",
        "PausableAccount",
        "NonTransferableAccount",
        "ImmutableOwner",
      ]
    );
    // 165 base + 1 account type + TLV headers (4 each) + 8 withheld + 1 transferring.
    assert.equal(getTokenSize(required), 165 + 1 + 5 * 4 + 8 + 1);
  });

  it("decodes a scaled display rule with its pending multiplier", () => {
    const terms = decode(
      mintAccount([
        {
          __kind: "ScaledUiAmountConfig",
          authority: AUTHORITY,
          multiplier: 1.5,
          newMultiplierEffectiveTimestamp: 1_900_000_000n,
          newMultiplier: 3,
        },
      ])
    );
    assert.deepEqual(terms.display, {
      kind: "scaled",
      multiplier: 1.5,
      newMultiplier: 3,
      newMultiplierEffectiveAt: 1_900_000_000n,
    });
    assert.equal(terms.transferFee, null);
  });

  it("decodes an interest display rule, negative rates included", () => {
    const terms = decode(
      mintAccount([
        {
          __kind: "InterestBearingConfig",
          rateAuthority: AUTHORITY,
          initializationTimestamp: 1_700_000_000n,
          preUpdateAverageRate: -250,
          lastUpdateTimestamp: 1_750_000_000n,
          currentRate: -500,
        },
      ])
    );
    assert.deepEqual(terms.display, {
      kind: "interest",
      initializedAt: 1_700_000_000n,
      lastUpdateAt: 1_750_000_000n,
      preUpdateAverageRate: -250,
      currentRate: -500,
    });
  });

  it("refuses an account owned by another program", () => {
    assert.throws(
      () => decode(mintOwnedBy(testAddress(9), null)),
      refusal(TOKEN_TERMS_REFUSALS.unsupportedProgram)
    );
  });

  it("refuses a mint owned by another token program than the catalogue names", () => {
    assert.throws(
      () =>
        decodeTokenTerms(
          { kind: "token", mint: MINT, program: "spl-token" },
          { mint: mintAccount(null), clock: clockAccount() }
        ),
      refusal(TOKEN_TERMS_REFUSALS.programMismatch)
    );
  });

  it("refuses a token account, an uninitialized mint and extensions on a classic mint", () => {
    const tokenAccount = getTokenEncoder().encode({
      mint: MINT,
      owner: AUTHORITY,
      amount: 1n,
      delegate: null,
      state: AccountState.Initialized,
      isNative: null,
      delegatedAmount: 0n,
      closeAuthority: null,
      extensions: [{ __kind: "ImmutableOwner" }],
    });
    for (const mint of [
      account(MINT, TOKEN_2022, tokenAccount),
      account(MINT, TOKEN_2022, tokenAccount.slice(0, 165)),
      account(MINT, TOKEN_2022, mintData(null, false)),
      mintOwnedBy(SPL_TOKEN, [{ __kind: "NonTransferable" }]),
    ]) {
      assert.throws(() => decode(mint), refusal(TOKEN_TERMS_REFUSALS.notMint));
    }
  });

  it("refuses extension states the program refuses", () => {
    const scaled: ExtensionArgs = {
      __kind: "ScaledUiAmountConfig",
      authority: AUTHORITY,
      multiplier: 2,
      newMultiplierEffectiveTimestamp: 0n,
      newMultiplier: 2,
    };
    const interest: ExtensionArgs = {
      __kind: "InterestBearingConfig",
      rateAuthority: AUTHORITY,
      initializationTimestamp: 0n,
      preUpdateAverageRate: 1,
      lastUpdateTimestamp: 0n,
      currentRate: 1,
    };
    for (const extensions of [
      [scaled, interest],
      [{ ...scaled, newMultiplier: 0 }],
      [{ ...scaled, multiplier: Number.POSITIVE_INFINITY }],
      [transferFeeConfig({ epoch: 0n, bps: 10_001, max: 1n }, { epoch: 0n, bps: 1, max: 1n })],
      [{ __kind: "TransferFeeAmount", withheldAmount: 0n }],
      [{ __kind: "DefaultAccountState", state: AccountState.Uninitialized }],
    ] satisfies ExtensionArgs[][]) {
      assert.throws(
        () => decode(mintAccount(extensions)),
        refusal(TOKEN_TERMS_REFUSALS.invalidExtension),
        JSON.stringify(extensions, (_, value) => (typeof value === "bigint" ? `${value}` : value))
      );
    }
  });

  it("refuses accounts that are not the requested mint and the Clock", () => {
    assert.throws(
      () =>
        decodeTokenTerms(
          { kind: "mint", mint: testAddress(8) },
          { mint: mintAccount(null), clock: clockAccount() }
        ),
      /Expected the mint account/
    );
    assert.throws(
      () =>
        decodeTokenTerms(
          { kind: "mint", mint: MINT },
          { mint: mintAccount(null), clock: mintAccount(null) }
        ),
      /Expected the Clock sysvar/
    );
  });
});

describe("transfer fee rules", () => {
  /** `debit − fee(debit)`, the forward rule. */
  const creditOf = (terms: MintTokenTerms, debit: bigint) =>
    debit - feeFor(terms, baseUnits(debit), 0n);

  it("picks the newer fee from its epoch on", () => {
    const terms = decode(
      mintAccount([
        transferFeeConfig({ epoch: 0n, bps: 50, max: 10n }, { epoch: 702n, bps: 100, max: 20n }),
      ])
    );
    assert.equal(epochFee(terms, 701n)?.basisPoints, 50);
    assert.equal(epochFee(terms, 702n)?.basisPoints, 100);
    assert.equal(epochFee(terms, 9_999n)?.basisPoints, 100);
    assert.equal(epochFee(displayTerms(PLAIN, 6), 1n), null);
  });

  it("rounds the fee up and caps it at the maximum", () => {
    const terms = feeTerms(50, 5_000n);
    assert.equal(feeFor(terms, baseUnits(1_000_000n), 0n), 5_000n);
    assert.equal(feeFor(terms, baseUnits(1n), 0n), 1n);
    assert.equal(feeFor(terms, baseUnits(201n), 0n), 2n);
    assert.equal(feeFor(terms, baseUnits(10_000_000n), 0n), 5_000n);
    assert.equal(feeFor(terms, baseUnits(0n), 0n), 0n);
  });

  it("charges nothing at 0 bps, whatever the maximum", () => {
    const terms = feeTerms(0, U64_MAX);
    assert.equal(feeFor(terms, baseUnits(U64_MAX), 0n), 0n);
    assert.equal(debitForCredit(terms, baseUnits(U64_MAX), 0n), U64_MAX);
  });

  it("charges the whole debit up to the maximum at 10 000 bps", () => {
    const terms = feeTerms(10_000, 7n);
    assert.equal(feeFor(terms, baseUnits(5n), 0n), 5n);
    assert.equal(feeFor(terms, baseUnits(100n), 0n), 7n);
    assert.equal(debitForCredit(terms, baseUnits(0n), 0n), 0n);
    assert.equal(debitForCredit(terms, baseUnits(93n), 0n), 100n);
    assert.throws(() => debitForCredit(feeTerms(10_000, U64_MAX), baseUnits(1n), 0n), AmountError);
  });

  it("refuses a credit no u64 debit reaches", () => {
    assert.throws(() => debitForCredit(feeTerms(50, 5_000n), baseUnits(U64_MAX), 0n), AmountError);
  });

  it("returns the smallest debit for every credit, checked by brute force", () => {
    for (const bps of [1, 3, 50, 333, 5_000, 9_000, 10_000]) {
      for (const max of [0n, 1n, 7n, 1_000n, U64_MAX]) {
        if (bps === 10_000 && max === U64_MAX) continue;
        const terms = feeTerms(bps, max);
        let debit = 0n;
        for (let credit = 0n; credit <= 200n; credit += 1n) {
          while (creditOf(terms, debit) < credit) debit += 1n;
          assert.equal(
            debitForCredit(terms, baseUnits(credit), 0n),
            debit,
            `${bps} ${max} ${credit}`
          );
        }
      }
    }
  });

  it("holds credit = debit − fee and finds the minimal debit for random inputs", () => {
    const random = seededRandom(0xfee5_0001n);
    const bpsChoices = [0, 1, 2, 9, 50, 100, 2_500, 9_999, 10_000];
    for (let index = 0; index < 3_000; index += 1) {
      const bps = random.below(3) === 0 ? random.below(10_001) : random.pick(bpsChoices);
      const max = random.pick([0n, 1n, 5_000n, random.u64(), U64_MAX]);
      const terms = feeTerms(bps, max);
      const debit = random.u64();
      const fee = feeFor(terms, baseUnits(debit), 0n);
      const expectedFee = bps === 0 || debit === 0n ? 0n : (debit * BigInt(bps) + 9_999n) / 10_000n;
      assert.equal(fee, expectedFee < max ? expectedFee : max);
      const credit = baseUnits(debit - fee);
      const minimal = debitForCredit(terms, credit, 0n);
      const label = `bps ${bps} max ${max} debit ${debit}`;
      assert.equal(creditOf(terms, minimal), credit, label);
      assert.ok(minimal <= debit, label);
      assert.ok(minimal === 0n || creditOf(terms, minimal - 1n) < credit, label);
    }
  });
});

describe("display rules", () => {
  const scaled = (multiplier: number, decimals: number) =>
    displayTerms(
      {
        kind: "scaled",
        multiplier,
        newMultiplier: multiplier,
        newMultiplierEffectiveAt: unixTimestamp(1n),
      },
      decimals
    );
  const interest = (preUpdateAverageRate: number, currentRate: number, decimals: number) =>
    displayTerms(
      {
        kind: "interest",
        initializedAt: unixTimestamp(0n),
        lastUpdateAt: unixTimestamp(SECONDS_PER_YEAR),
        preUpdateAverageRate,
        currentRate,
      },
      decimals
    );
  const shown = (terms: MintTokenTerms, units: bigint, at: bigint) =>
    toDisplay(terms, baseUnits(units), unixTimestamp(at)).value;

  // The program's `specific_amount_to_ui_amount` vectors, `scaled_ui_amount/mod.rs`.
  it("matches the program's scaled vectors, truncation included", () => {
    assert.equal(shown(scaled(5, 0), 1n, 0n), "5");
    assert.equal(shown(scaled(5, 1), 1n, 0n), "0.5");
    assert.equal(shown(scaled(5, 10), 1n, 0n), "0.0000000005");
    assert.equal(shown(scaled(5, 10), 10_000_000_000n, 0n), "5");
    assert.equal(shown(scaled(0.99, 2), 101n, 0n), "0.99");
    assert.throws(() => shown(scaled(Number.MAX_VALUE, 0), U64_MAX, 0n), AmountError);
  });

  // The program's `specific_amount_to_ui_amount` vectors, `interest_bearing_mint/mod.rs`.
  it("matches the program's interest vectors", () => {
    const one = 1_000_000_000_000_000_000n;
    assert.equal(shown(interest(500, 500, 18), one, SECONDS_PER_YEAR), "1.051271096376024117");
    assert.equal(shown(interest(500, 500, 19), one, SECONDS_PER_YEAR), "0.1051271096376024117");
    assert.equal(
      shown(interest(500, 500, 28), one, SECONDS_PER_YEAR),
      "0.0000000001051271096376024175"
    );
    assert.equal(shown(interest(500, 500, 10), 10_000_000_000n, SECONDS_PER_YEAR), "1.0512710964");
    assert.equal(shown(interest(-500, -500, 18), one, SECONDS_PER_YEAR), "0.951229424500713905");
    assert.equal(shown(interest(-500, 500, 0), 1n, SECONDS_PER_YEAR * 2n), "1");
    assert.equal(
      shown(interest(500, 500, 0), U64_MAX, SECONDS_PER_YEAR * 2n),
      "20386805083448098816"
    );
  });

  it("switches to the new multiplier at its effective time", () => {
    const terms = displayTerms(
      {
        kind: "scaled",
        multiplier: 1.5,
        newMultiplier: 2,
        newMultiplierEffectiveAt: unixTimestamp(1_000n),
      },
      6
    );
    assert.equal(shown(terms, 1_000_000n, 999n), "1.5");
    assert.equal(shown(terms, 1_000_000n, 1_000n), "2");
  });

  it("shows plain mints exactly, carrying the rule and time", () => {
    const at = unixTimestamp(5n);
    assert.deepEqual(toDisplay(NATIVE_TOKEN_TERMS, baseUnits(1_500_000_000n), at), {
      value: "1.5",
      rule: { kind: "plain" },
      asOf: at,
    });
    assert.equal(shown(displayTerms(PLAIN, 6), U64_MAX, 0n), "18446744073709.551615");
  });
});
