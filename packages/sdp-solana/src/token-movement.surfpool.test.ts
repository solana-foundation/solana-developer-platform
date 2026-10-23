/**
 * The token movement builder against the program itself, on an embedded
 * offline surfnet (ADR 0012). Opt-in: run `pnpm token-movements:surfpool:e2e`
 * from the repository root. It needs no network, no Docker and no secret.
 *
 * For every mint matrix profile it plans a movement the way Payments does
 * (Token Terms, the quote, the destination read, the hook accounts) and
 * sends exactly what `buildTokenMovement` builds:
 *
 * - every movable profile debits, withholds and credits exactly the quote;
 * - a stale fee fails on chain instead of settling short;
 * - paused, frozen-by-default, scaled, interest-bearing and unresolved-hook
 *   mints are refused first;
 * - a destination address someone sent lamports to before it was opened
 *   still opens;
 * - a memo-required destination gets its memo, which the program demands;
 * - native SOL moves lamports, and wrapped SOL moves as an SPL token;
 * - a Solana Pay reference rides the transfer.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { SOL_MINT, SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import {
  type Address,
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  fetchEncodedAccount,
  generateKeyPairSigner,
  isSolanaError,
  lamports,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  type TransactionSigner,
  unixTimestamp,
} from "@solana/kit";
import type { Surfnet } from "@solana/surfpool";
import { fetchSysvarClock } from "@solana/sysvars";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  ExtensionType,
  getEnableMemoTransfersInstruction,
  getReallocateInstruction,
  getSetTransferFeeInstruction,
  getSyncNativeInstruction,
} from "@solana-program/token-2022";
import { resolveAssetRequest } from "./asset-ref";
import { type MovementQuote, quoteMovement } from "./movement-quote";
import {
  createMintMatrix,
  holdings,
  type MatrixChain,
  type MatrixMint,
  type MintMatrix,
  type MintProfile,
  mintTokens,
  openTokenAccount,
  pauseMint,
  readMatrixTerms,
  sendInstructions,
} from "./test/mint-matrix";
import { parseTokenAmount } from "./token-amount";
import {
  buildTokenMovement,
  type DestinationTokenAccount,
  decodeDestinationTokenAccount,
  destinationTokenAccountAddress,
  resolveTransferHookAccounts,
  support,
  TOKEN_MOVEMENT_REFUSALS,
  TokenMovementError,
} from "./token-movement";
import { type MintTokenTerms, NATIVE_TOKEN_TERMS } from "./token-terms";

const ENABLED = process.env.TOKEN_MOVEMENT_SURFPOOL_E2E === "true";

const ONE_HOUR_SECONDS = 3_600n;

/** Every source holds this many base units, enough for every case. */
const SOURCE_BALANCE = 10n ** 12n;

/** A planned token movement: what Payments reads and quotes before it builds. */
interface PlannedMovement {
  terms: MintTokenTerms;
  quote: MovementQuote;
  source: Address;
  destination: DestinationTokenAccount;
}

/** Asserts the program refused a transaction in preflight, with `logLine` in its logs. */
async function assertRefused(sending: Promise<unknown>, logLine: string): Promise<void> {
  await assert.rejects(sending, (error: unknown) => {
    assert.ok(
      isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)
    );
    assert.ok(
      error.context.logs?.some((line) => line.includes(logLine)),
      `${logLine} in ${JSON.stringify(error.context.logs)}`
    );
    return true;
  });
}

function refusal(reason: string) {
  return (error: unknown) => error instanceof TokenMovementError && error.reason === reason;
}

describe("The token movement builder on a surfnet mint matrix", { skip: !ENABLED }, () => {
  let surfnet: Surfnet;
  let chain: MatrixChain;
  let matrix: MintMatrix;

  before(async () => {
    const { Surfnet: SurfnetRuntime } = await import("@solana/surfpool");
    surfnet = SurfnetRuntime.start();
    const rpc = createSolanaRpc(surfnet.rpcUrl);
    chain = { rpc, payer: await createKeyPairSignerFromBytes(surfnet.payerSecretKey) };
    const clock = await fetchSysvarClock(rpc);
    matrix = await createMintMatrix(chain, {
      newMultiplierAt: unixTimestamp(clock.unixTimestamp + ONE_HOUR_SECONDS),
      hookProgram: (await generateKeyPairSigner()).address,
    });
  });

  after(() => {
    surfnet.stop();
  });

  /** The payer's funded source account of a profile mint. */
  async function fundedSource(mint: MatrixMint): Promise<Address> {
    const source = await openTokenAccount(chain, mint, chain.payer.address);
    await mintTokens(chain, mint, source, SOURCE_BALANCE);
    return source;
  }

  /** Reads the terms and the destination, and quotes, as the Payments planner does. */
  async function plan(
    mint: Pick<MatrixMint, "mint" | "program">,
    movement: { source: Address; recipient: Address; amount: string; basis: "debit" | "credit" }
  ): Promise<PlannedMovement> {
    const terms = await readMatrixTerms(chain, mint);
    const quote = quoteMovement(terms, {
      asset: terms.asset,
      amount: parseTokenAmount(movement.amount, terms.decimals),
      basis: movement.basis,
    });
    const tokenAccount = await destinationTokenAccountAddress(terms, movement.recipient);
    const destination = decodeDestinationTokenAccount(
      terms,
      movement.recipient,
      tokenAccount,
      await fetchEncodedAccount(chain.rpc, tokenAccount)
    );
    return { terms, quote, source: movement.source, destination };
  }

  /** What `buildTokenMovement` builds for a planned movement, hook accounts resolved. */
  async function build(
    planned: PlannedMovement,
    extra: { memo: string | null; reference: Address | null; authority: TransactionSigner }
  ) {
    const [hookAccounts] = await resolveTransferHookAccounts(chain.rpc, planned.terms, [
      {
        source: planned.source,
        destination: planned.destination.tokenAccount,
        owner: extra.authority.address,
        amount: planned.quote.debit,
      },
    ]);
    return buildTokenMovement(planned.terms, planned.quote, {
      authority: extra.authority,
      rentPayer: chain.payer,
      accounts: {
        kind: "token",
        source: planned.source,
        destination: planned.destination,
        hookAccounts,
      },
      memo: extra.memo,
      reference: extra.reference,
    });
  }

  const unsigned = () => ({ memo: null, reference: null, authority: chain.payer });

  it("moves exactly the quoted debit, fee and credit for every movable profile", async () => {
    const cases: readonly [MintProfile, string, "debit" | "credit"][] = [
      ["classic", "1.5", "debit"],
      ["classic", "2", "credit"],
      ["token2022Plain", "1.5", "debit"],
      ["feeZero", "1", "debit"],
      ["feeZero", "2.5", "credit"],
      ["feeCapped", "1", "debit"],
      ["feeCapped", "0.333333", "debit"],
      ["feeCapped", "0.995", "credit"],
      ["feeCapped", "250", "credit"],
      ["feeCapped", "1000", "debit"],
      // Payments refuses these (support() below) until PR 5; the builder still moves them exactly.
      ["scaled", "3", "debit"],
      ["scaledSwitch", "3", "credit"],
      ["interestPositive", "1.25", "debit"],
      ["interestNegative", "1.25", "credit"],
    ];
    const sources = new Map<MintProfile, Address>();
    for (const [profile, amount, basis] of cases) {
      const mint = matrix[profile];
      let source = sources.get(profile);
      if (source === undefined) {
        source = await fundedSource(mint);
        sources.set(profile, source);
      }
      const recipient = (await generateKeyPairSigner()).address;
      const planned = await plan(mint, { source, recipient, amount, basis });
      assert.equal(planned.destination.exists, false);
      const before = await holdings(chain, source);

      await sendInstructions(chain, await build(planned, unsigned()));

      const label = `${profile} ${basis} ${amount}`;
      const [sourceAfter, received] = [
        await holdings(chain, source),
        await holdings(chain, planned.destination.tokenAccount),
      ];
      assert.equal(before.amount - sourceAfter.amount, planned.quote.debit, label);
      assert.equal(received.amount, planned.quote.credit, label);
      assert.equal(received.withheld, planned.quote.fee, label);
    }
  });

  it("refuses paused, frozen-by-default, scaled, interest-bearing and unresolved-hook mints before building", async () => {
    await pauseMint(chain, matrix.paused);
    for (const [profile, reason] of [
      ["paused", TOKEN_MOVEMENT_REFUSALS.paused],
      ["defaultFrozen", TOKEN_MOVEMENT_REFUSALS.defaultFrozen],
      ["scaled", TOKEN_MOVEMENT_REFUSALS.scaledDisplay],
      ["scaledSwitch", TOKEN_MOVEMENT_REFUSALS.scaledDisplay],
      ["interestPositive", TOKEN_MOVEMENT_REFUSALS.scaledDisplay],
      ["interestNegative", TOKEN_MOVEMENT_REFUSALS.scaledDisplay],
    ] as const) {
      const decision = support(await readMatrixTerms(chain, matrix[profile]), "builder");
      assert.deepEqual(decision.supported === false && decision.refusal, reason, profile);
    }

    const hook = matrix.hook;
    const source = await fundedSource(hook);
    const recipient = (await generateKeyPairSigner()).address;
    const planned = await plan(hook, { source, recipient, amount: "1", basis: "debit" });
    assert.deepEqual(support(planned.terms, "builder"), { supported: true });
    await assert.rejects(
      build(planned, unsigned()),
      refusal(TOKEN_MOVEMENT_REFUSALS.hookUnresolved)
    );
  });

  it("opens a destination whose address was sent lamports before it existed", async () => {
    const mint = matrix.token2022Plain;
    const source = await fundedSource(mint);
    const recipient = (await generateKeyPairSigner()).address;
    const tokenAccount = await destinationTokenAccountAddress(
      await readMatrixTerms(chain, mint),
      recipient
    );
    await sendInstructions(chain, [
      getTransferSolInstruction({
        source: chain.payer,
        destination: tokenAccount,
        amount: 10n ** 6n,
      }),
    ]);

    const planned = await plan(mint, { source, recipient, amount: "1", basis: "debit" });
    assert.equal(planned.destination.exists, false);
    await sendInstructions(chain, await build(planned, unsigned()));
    assert.equal((await holdings(chain, tokenAccount)).amount, planned.quote.credit);
  });

  it("names the fee, so a quote from before a fee change fails on chain", async () => {
    const mint = matrix.feeCapped;
    const source = await fundedSource(mint);
    const recipient = (await generateKeyPairSigner()).address;
    await sendInstructions(chain, [
      getSetTransferFeeInstruction({
        mint: mint.mint,
        transferFeeConfigAuthority: chain.payer,
        transferFeeBasisPoints: 200,
        maximumFee: 40_000n,
      }),
    ]);
    const stale = await plan(mint, { source, recipient, amount: "1", basis: "debit" });
    const staleInstructions = await build(stale, unsigned());
    surfnet.timeTravelToEpoch(Number(stale.terms.readAt.epoch + 2n));

    await assertRefused(
      sendInstructions(chain, staleInstructions),
      "Calculated fee does not match expected fee"
    );
    const fresh = await plan(mint, { source, recipient, amount: "1", basis: "debit" });
    assert.equal(fresh.quote.fee, 20_000n);
    await sendInstructions(chain, await build(fresh, unsigned()));
    const received = await holdings(chain, fresh.destination.tokenAccount);
    assert.equal(received.amount, fresh.quote.credit);
    assert.equal(received.withheld, fresh.quote.fee);
  });

  it("sends the memo a memo-required destination demands, and the program demands it", async () => {
    const mint = matrix.token2022Plain;
    const source = await fundedSource(mint);
    const recipient = await generateKeyPairSigner();
    const tokenAccount = await openTokenAccount(chain, mint, recipient.address);
    await sendInstructions(chain, [
      getReallocateInstruction({
        token: tokenAccount,
        payer: chain.payer,
        owner: recipient,
        newExtensionTypes: [ExtensionType.MemoTransfer],
      }),
      getEnableMemoTransfersInstruction({ token: tokenAccount, owner: recipient }),
    ]);
    const planned = await plan(mint, {
      source,
      recipient: recipient.address,
      amount: "1",
      basis: "debit",
    });
    assert.equal(planned.destination.requiresMemo, true);

    await assert.rejects(build(planned, unsigned()), refusal(TOKEN_MOVEMENT_REFUSALS.memoRequired));
    const withoutMemo = await build(
      { ...planned, destination: { ...planned.destination, requiresMemo: false } },
      unsigned()
    );
    await assertRefused(sendInstructions(chain, withoutMemo), "No memo in previous instruction");

    await sendInstructions(
      chain,
      await build(planned, { memo: "invoice 42", reference: null, authority: chain.payer })
    );
    assert.equal((await holdings(chain, tokenAccount)).amount, planned.quote.credit);
  });

  it("moves native SOL by its debit in lamports, and wrapped SOL as an SPL token", async () => {
    const recipient = (await generateKeyPairSigner()).address;
    const native = resolveAssetRequest("SOL", "devnet");
    assert.equal(native.kind, "native");
    const solQuote = quoteMovement(NATIVE_TOKEN_TERMS, {
      asset: NATIVE_TOKEN_TERMS.asset,
      amount: parseTokenAmount("0.5", NATIVE_TOKEN_TERMS.decimals),
      basis: "debit",
    });
    await sendInstructions(
      chain,
      buildTokenMovement(NATIVE_TOKEN_TERMS, solQuote, {
        authority: chain.payer,
        rentPayer: chain.payer,
        accounts: { kind: "native", destination: recipient },
        memo: null,
        reference: null,
      })
    );
    const { value: balance } = await chain.rpc.getBalance(recipient).send();
    assert.equal(balance, lamports(solQuote.debit));

    const wrapped = resolveAssetRequest(SOL_MINT, "devnet");
    assert.deepEqual(wrapped, { kind: "token", mint: SOL_MINT, program: "spl-token" });
    if (wrapped.kind !== "token") {
      assert.fail("wrapped SOL resolved to native SOL");
    }
    const wrappedMint = { mint: wrapped.mint, program: wrapped.program };
    const source = await openTokenAccount(chain, wrappedMint, chain.payer.address);
    await sendInstructions(chain, [
      getTransferSolInstruction({ source: chain.payer, destination: source, amount: 10n ** 9n }),
      getSyncNativeInstruction(
        { account: source },
        { programAddress: address(SPL_TOKEN_PROGRAMS["spl-token"]) }
      ),
    ]);
    const planned = await plan(wrappedMint, {
      source,
      recipient,
      amount: "0.25",
      basis: "debit",
    });
    assert.equal(planned.terms.decimals, 9);
    await sendInstructions(chain, await build(planned, unsigned()));
    assert.equal((await holdings(chain, planned.destination.tokenAccount)).amount, 250_000_000n);
  });

  it("lands a Solana Pay reference on the transfer", async () => {
    const mint = matrix.feeZero;
    const source = await fundedSource(mint);
    const recipient = (await generateKeyPairSigner()).address;
    const reference = (await generateKeyPairSigner()).address;
    const planned = await plan(mint, { source, recipient, amount: "2", basis: "debit" });

    const signature = await sendInstructions(
      chain,
      await build(planned, { memo: null, reference, authority: chain.payer })
    );

    const found = await chain.rpc.getSignaturesForAddress(reference).send();
    assert.deepEqual(
      found.map((entry) => entry.signature),
      [signature]
    );
  });
});
