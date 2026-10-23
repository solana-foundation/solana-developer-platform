/**
 * Token Terms against the program itself, on an embedded offline surfnet
 * (ADR 0012). Opt-in: run `pnpm token-movements:surfpool:e2e` from the
 * repository root. It needs no network, no Docker and no secret.
 *
 * For every mint matrix profile it decodes the live mint with the same
 * request and decoder `readTokenTerms` uses, then checks the pure rules
 * against what the program does:
 *
 * - a real transfer debits, withholds and credits exactly the quoted amounts;
 * - `requiredAccountExtensions` sizes a token account as the program does;
 * - paused, hook, frozen-default and fee-change mints behave as their terms say.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { TokenMovementBasis } from "@sdp/types/token-movements";
import { SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import {
  type Address,
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  generateKeyPairSigner,
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  type UnixTimestamp,
  unixTimestamp,
} from "@solana/kit";
import type { Surfnet } from "@solana/surfpool";
import type { createSurfnetCheatcodesRpc } from "@solana/surfpool/kit";
import { fetchSysvarClock } from "@solana/sysvars";
import {
  AccountState,
  getSetTransferFeeInstruction,
  getTokenSize,
  getTransferCheckedInstruction,
  getTransferCheckedWithFeeInstruction,
} from "@solana-program/token-2022";
import { type MovementQuote, quoteMovement } from "./movement-quote";
import {
  CAPPED_FEE,
  createMintMatrix,
  holdings,
  INTEREST_RATE_BPS,
  MATRIX_DECIMALS,
  type MatrixChain,
  type MatrixMint,
  type MintMatrix,
  type MintProfile,
  mintTokens,
  openTokenAccount,
  pauseMint,
  readMatrixTerms,
  SCALED_MULTIPLIER,
  SWITCHED_MULTIPLIER,
  sendInstructions,
} from "./test/mint-matrix";
import { parseTokenAmount } from "./token-amount";
import type { MintTokenTerms } from "./token-terms";

const ENABLED = process.env.TOKEN_MOVEMENT_SURFPOOL_E2E === "true";

type SurfnetCheatcodes = ReturnType<typeof createSurfnetCheatcodesRpc>;

const ONE_HOUR_SECONDS = 3_600n;

/** The transfer instruction a quote asks for: `TransferCheckedWithFee` whenever a fee config exists. */
function transferInstruction(
  chain: MatrixChain,
  terms: MintTokenTerms,
  quote: MovementQuote,
  accounts: { source: Address; destination: Address }
) {
  const programAddress = address(SPL_TOKEN_PROGRAMS[terms.asset.program]);
  const common = {
    source: accounts.source,
    mint: terms.asset.mint,
    destination: accounts.destination,
    authority: chain.payer,
    amount: quote.debit,
    decimals: terms.decimals,
  };
  return terms.transferFee === null
    ? getTransferCheckedInstruction(common, { programAddress })
    : getTransferCheckedWithFeeInstruction({ ...common, fee: quote.fee }, { programAddress });
}

/** Asserts the program refused a transaction in preflight, with `logLine` in its logs. */
async function assertRefused(sending: Promise<unknown>, logLine: string): Promise<void> {
  await assert.rejects(sending, (error: unknown) => {
    assert.ok(
      isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)
    );
    assert.ok(
      error.context.logs?.some((line) => line.includes(logLine)),
      logLine
    );
    return true;
  });
}

describe("Token Terms on a surfnet mint matrix", { skip: !ENABLED }, () => {
  let surfnet: Surfnet;
  let _cheatcodes: SurfnetCheatcodes;
  let chain: MatrixChain;
  let matrix: MintMatrix;
  let hookProgram: Address;
  let newMultiplierAt: UnixTimestamp;

  before(async () => {
    const { Surfnet: SurfnetRuntime } = await import("@solana/surfpool");
    const { createSurfnetCheatcodesRpc } = await import("@solana/surfpool/kit");
    surfnet = SurfnetRuntime.start();
    _cheatcodes = createSurfnetCheatcodesRpc(surfnet.rpcUrl);
    const rpc = createSolanaRpc(surfnet.rpcUrl);
    chain = { rpc, payer: await createKeyPairSignerFromBytes(surfnet.payerSecretKey) };
    hookProgram = (await generateKeyPairSigner()).address;
    const clock = await fetchSysvarClock(rpc);
    newMultiplierAt = unixTimestamp(clock.unixTimestamp + ONE_HOUR_SECONDS);
    matrix = await createMintMatrix(chain, { newMultiplierAt, hookProgram });
  });

  after(() => {
    surfnet.stop();
  });

  it("decodes every profile as the program wrote it", async () => {
    const terms = Object.fromEntries(
      await Promise.all(
        Object.values(matrix).map(async (mint) => [
          mint.profile,
          await readMatrixTerms(chain, mint),
        ])
      )
    );
    for (const mint of Object.values(matrix)) {
      const decoded: MintTokenTerms = terms[mint.profile];
      assert.deepEqual(decoded.asset, { kind: "token", mint: mint.mint, program: mint.program });
      assert.equal(decoded.decimals, MATRIX_DECIMALS, mint.profile);
      assert.equal(decoded.freezeAuthority, chain.payer.address, mint.profile);
    }
    const rate = (basisPoints: number, maximumFee: bigint) => ({
      epoch: 0n,
      basisPoints,
      maximumFee,
    });
    assert.equal(terms.classic.transferFee, null);
    assert.deepEqual(terms.classic.display, { kind: "plain" });
    assert.equal(terms.token2022Plain.transferFee, null);
    assert.deepEqual(terms.feeZero.transferFee, { older: rate(0, 0n), newer: rate(0, 0n) });
    const capped = rate(CAPPED_FEE.basisPoints, CAPPED_FEE.maximumFee);
    assert.deepEqual(terms.feeCapped.transferFee, { older: capped, newer: capped });
    assert.deepEqual(terms.scaled.display, {
      kind: "scaled",
      multiplier: SCALED_MULTIPLIER,
      newMultiplier: SCALED_MULTIPLIER,
      newMultiplierEffectiveAt: 0n,
    });
    assert.deepEqual(terms.scaledSwitch.display, {
      kind: "scaled",
      multiplier: SCALED_MULTIPLIER,
      newMultiplier: SWITCHED_MULTIPLIER,
      newMultiplierEffectiveAt: newMultiplierAt,
    });
    for (const [profile, rateBps] of [
      ["interestPositive", INTEREST_RATE_BPS],
      ["interestNegative", -INTEREST_RATE_BPS],
    ] as const) {
      const display = terms[profile].display;
      if (display.kind !== "interest") {
        assert.fail(`${profile} decoded as ${display.kind}`);
      }
      assert.equal(display.currentRate, rateBps, profile);
      assert.equal(display.preUpdateAverageRate, rateBps, profile);
    }
    assert.equal(terms.hook.transferHookProgram, hookProgram);
    assert.equal(terms.paused.paused, false);
    assert.equal(terms.defaultFrozen.defaultAccountState, "frozen");
  });

  it("sizes a new token account as the program does", async () => {
    for (const mint of Object.values(matrix)) {
      const terms = await readMatrixTerms(chain, mint);
      const owner = (await generateKeyPairSigner()).address;
      const tokenAccount = await openTokenAccount(chain, mint, owner);
      const { value } = await chain.rpc
        .getAccountInfo(tokenAccount, { encoding: "base64", dataSlice: { offset: 0, length: 0 } })
        .send();
      assert.ok(value);
      const expected =
        mint.program === "spl-token"
          ? getTokenSize()
          : getTokenSize([{ __kind: "ImmutableOwner" }, ...terms.requiredAccountExtensions]);
      assert.equal(value.space, BigInt(expected), mint.profile);
      if (mint.profile === "defaultFrozen") {
        assert.equal((await holdings(chain, tokenAccount)).data.state, AccountState.Frozen);
      }
    }
  });

  it("moves exactly the quoted debit, fee and credit", async () => {
    const cases: readonly [MintProfile, string, TokenMovementBasis][] = [
      ["classic", "1.5", "debit"],
      ["classic", "2", "credit"],
      ["token2022Plain", "1.5", "debit"],
      ["feeZero", "1", "debit"],
      ["feeZero", "2.5", "credit"],
      ["feeCapped", "1", "debit"],
      ["feeCapped", "0.333333", "debit"],
      ["feeCapped", "0.000001", "debit"],
      ["feeCapped", "0.995", "credit"],
      ["feeCapped", "0.000001", "credit"],
      ["feeCapped", "250", "credit"],
      ["feeCapped", "1000", "debit"],
    ];
    const recipient = (await generateKeyPairSigner()).address;
    const accounts = new Map<MintProfile, { source: Address; destination: Address }>();
    for (const [profile, amount, basis] of cases) {
      const mint = matrix[profile];
      let pair = accounts.get(profile);
      if (pair === undefined) {
        pair = {
          source: await openTokenAccount(chain, mint, chain.payer.address),
          destination: await openTokenAccount(chain, mint, recipient),
        };
        await mintTokens(chain, mint, pair.source, 10n ** 12n);
        accounts.set(profile, pair);
      }
      const terms = await readMatrixTerms(chain, mint);
      const quote = quoteMovement(terms, {
        asset: terms.asset,
        amount: parseTokenAmount(amount, MATRIX_DECIMALS),
        basis,
      });
      assert.equal(quote.debit, quote.credit + quote.fee);
      const [source, destination] = [
        await holdings(chain, pair.source),
        await holdings(chain, pair.destination),
      ];

      await sendInstructions(chain, [transferInstruction(chain, terms, quote, pair)]);

      const [sourceAfter, destinationAfter] = [
        await holdings(chain, pair.source),
        await holdings(chain, pair.destination),
      ];
      const label = `${profile} ${basis} ${amount}`;
      assert.equal(source.amount - sourceAfter.amount, quote.debit, label);
      assert.equal(destinationAfter.amount - destination.amount, quote.credit, label);
      assert.equal(destinationAfter.withheld - destination.withheld, quote.fee, label);
    }
  });

  it("refuses transfers of a paused mint and of a mint whose hook program is set", async () => {
    const recipient = (await generateKeyPairSigner()).address;
    const pairs = new Map<"paused" | "hook", { source: Address; destination: Address }>();
    for (const profile of ["paused", "hook"] as const) {
      const mint = matrix[profile];
      const pair = {
        source: await openTokenAccount(chain, mint, chain.payer.address),
        destination: await openTokenAccount(chain, mint, recipient),
      };
      await mintTokens(chain, mint, pair.source, 1_000_000n);
      pairs.set(profile, pair);
    }
    await pauseMint(chain, matrix.paused);

    for (const [profile, pair] of pairs) {
      const mint = matrix[profile];
      const terms = await readMatrixTerms(chain, mint);
      assert.equal(terms.paused, profile === "paused");
      const quote = quoteMovement(terms, {
        asset: terms.asset,
        amount: parseTokenAmount("0.000001", MATRIX_DECIMALS),
        basis: "debit",
      });
      await assertRefused(
        sendInstructions(chain, [transferInstruction(chain, terms, quote, pair)]),
        profile === "paused"
          ? "Transferring, minting, and burning is paused on this mint"
          : `Unknown program ${hookProgram}`
      );
    }
  });

  it("applies a fee change from the epoch the program sets, and refuses a stale fee", async () => {
    const mint = matrix.feeCapped;
    const recipient = (await generateKeyPairSigner()).address;
    const pair = {
      source: await openTokenAccount(chain, mint, chain.payer.address),
      destination: await openTokenAccount(chain, mint, recipient),
    };
    await mintTokens(chain, mint, pair.source, 10n ** 9n);
    await sendInstructions(chain, [
      getSetTransferFeeInstruction({
        mint: mint.mint,
        transferFeeConfigAuthority: chain.payer,
        transferFeeBasisPoints: 100,
        maximumFee: 20_000n,
      }),
    ]);
    const pending = await readMatrixTerms(chain, mint);
    const effectiveEpoch = pending.readAt.epoch + 2n;
    assert.equal(pending.transferFee?.newer.epoch, effectiveEpoch);
    const intent = {
      asset: pending.asset,
      amount: parseTokenAmount("1", MATRIX_DECIMALS),
      basis: "debit" as const,
    };
    const staleQuote = quoteMovement(pending, intent);
    assert.equal(staleQuote.fee, 5_000n);

    surfnet.timeTravelToEpoch(Number(effectiveEpoch));
    const effective = await readMatrixTerms(chain, mint);
    const quote = quoteMovement(effective, intent);
    assert.equal(quote.feeEpoch, effectiveEpoch);
    assert.equal(quote.fee, 10_000n);

    // The fee a transfer names must be the fee of the epoch it lands in.
    await assertRefused(
      sendInstructions(chain, [transferInstruction(chain, effective, staleQuote, pair)]),
      "Calculated fee does not match expected fee"
    );
    const destination = await holdings(chain, pair.destination);
    await sendInstructions(chain, [transferInstruction(chain, effective, quote, pair)]);
    const destinationAfter = await holdings(chain, pair.destination);
    assert.equal(destinationAfter.amount - destination.amount, quote.credit);
    assert.equal(destinationAfter.withheld - destination.withheld, quote.fee);
  });
});
