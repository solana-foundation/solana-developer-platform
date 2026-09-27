/**
 * Creating a DvP trade.
 *
 * Flow A from PRO-1830: SDP holds one leg in a custody wallet, the counterparty
 * is an arbitrary address we know nothing about.
 *
 * Two things about `CreateDvp` shape this whole function.
 *
 * Only the PAYER signs, and that payer is Kora's sponsor. `user_a`, `user_b`
 * and `settlement_authority` are plain accounts on the instruction, so the
 * counterparty signs nothing here and needs no integration with us. Verified on devnet by creating a trade with addresses
 * we hold no keys for. It also means the instruction creates no obligation: a
 * SwapDvp is a proposal until someone funds it.
 *
 * The row is claimed before signing because sponsorship budget is consumed at
 * sign time. Claim, sign, attach, send makes the idempotency race finish before
 * either request can spend budget, while preserving the signed transaction as
 * the durable marker before broadcast.
 *
 * And because it is permissionless, a created trade is NOT proof of agreement.
 * Anyone can create one naming anyone, and the economic terms are not part of
 * the PDA seeds, so the address does not bind them. Whoever funds has to verify
 * the stored terms first, which is what `verifySwapDvp` + `assertSwapDvpTerms`
 * in `@sdp/dvp` are for.
 */

import { findDvpNonceTombstonePda, findSwapDvpPda, getCreateDvpInstruction } from "@sdp/dvp";
import * as solanaRpc from "@sdp/rpc/solana";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getTransactionEncoder,
  none,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  some,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import type { Context } from "hono";
import { getDb } from "@/db";
import {
  createCounterpartyAccountsRepository,
  createDvpTradeRepository,
  type DvpTradeRow,
} from "@/db/repositories";
import { type AppError, badRequest, conflict } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { readSolanaCryptoWalletAddress } from "@/services/payments/counterparty-account-resolution";
import { createProjectSponsorshipFeePayment } from "@/services/sponsorship.service";
import {
  isDefiniteSubmissionError,
  submitSponsoredTransaction,
} from "@/services/sponsorship-submission";
import type { Env } from "@/types/env";
import { dvpCreateFingerprint, type ResolvedParty } from "./fingerprint";
import { describeDvpDestinationProblem, findDvpDestinationProblem } from "./inspect-destination";
import { inspectDvpMint } from "./inspect-mint";
import { validateDvpMints } from "./mints";
import { randomDvpNonce } from "./nonce";
import { observeDvpTradeIfStale, observeDvpTradeNow } from "./observe-now";
import { readEscrowState } from "./read-chain";
import { getOrCreateDvpSettlementWallet } from "./settlement-wallet";
import { validateDvpTerms } from "./validate";

/**
 * One party slot: `walletId` (resolves to the wallet's address, stores
 * nothing), `counterpartyAccountId` (resolves the linked address, stores the
 * ref), or a bare external `address`.
 */
export type DvpPartyInput =
  | { walletId: string }
  | { counterpartyAccountId: string }
  | { address: Address };

export type CreateDvpTradeInput = {
  organizationId: string;
  projectId: string;
  /** The two parties, each as the caller described them. */
  partyA: DvpPartyInput;
  partyB: DvpPartyInput;
  /** Asset leg mint and its token program. */
  mintA: Address;
  tokenProgramA: Address;
  /** Cash leg mint and its token program. */
  mintB: Address;
  tokenProgramB: Address;
  amountA: bigint;
  amountB: bigint;
  expiryTimestamp: bigint;
  earliestSettlementTimestamp: bigint | null;
  refString: string | null;
  /**
   * Where each party's proceeds go, when that is not the party itself.
   *
   * Null means the party's own address, which is what the program records for
   * an omitted destination. Kept nullable all the way to the instruction rather
   * than resolved at the edge, so "the caller asked for the default" and "the
   * caller asked for this address, which happens to be the party" stay
   * distinguishable in the fingerprint.
   */
  userASettlementDestination: Address | null;
  userBSettlementDestination: Address | null;
  /** Caller's Idempotency-Key, when they sent one. */
  idempotencyKey: string | null;
};

/**
 * Confirms a replay is the SAME request, not merely one carrying the same key.
 *
 * A key is a claim, not a proof; the fingerprint is compared precisely so a
 * wallet-scoped caller never receives escrows outside its scope.
 */
function assertOwnReplay(trade: DvpTradeRow, fingerprint: string | null): DvpTradeRow {
  if (trade.idempotencyFingerprint !== fingerprint) {
    throw conflict("Idempotency key already used with different request payload");
  }
  return trade;
}

/**
 * Inserts the trade, or returns the one a concurrent keyed request just wrote.
 *
 * Two overlapping retries both miss the lookup above and both reach the insert.
 * The unique index rejects the loser, and without this it would surface as a
 * 500 — the exact case the key exists to make safe.
 */
async function insertOrReplay(
  repository: ReturnType<typeof createDvpTradeRepository>,
  failedRowId: string | null,
  idempotencyKey: string | null,
  fingerprint: string | null,
  row: Parameters<ReturnType<typeof createDvpTradeRepository>["create"]>[0]
): Promise<DvpTradeRow> {
  try {
    return await repository.claimWithKeyRelease(failedRowId, row);
  } catch (error) {
    if (!idempotencyKey) {
      throw error;
    }
    const winner = await repository.getByIdempotencyKey(row.projectId, idempotencyKey);
    if (!winner) {
      throw error;
    }
    return assertOwnReplay(winner, fingerprint);
  }
}

/**
 * The fallback for mints that carry no metadata of their own, which is every
 * legacy SPL token including the stablecoins most cash legs use.
 */
function wellKnownToken(mint: string): { symbol: string | null; name: string | null } {
  const token = WELL_KNOWN_TOKEN_BY_MINT.get(mint);
  if (token === undefined) {
    return { symbol: null, name: null };
  }
  return { symbol: token.symbol, name: token.name };
}

function storedMintMetadata(
  inspected: Awaited<ReturnType<typeof inspectDvpMint>>,
  registered: ReturnType<typeof wellKnownToken>
): { decimals: number | null; symbol: string | null; name: string | null } {
  if (inspected === null) {
    return { decimals: null, symbol: registered.symbol, name: registered.name };
  }
  return {
    decimals: inspected.decimals,
    symbol: inspected.symbol === null ? registered.symbol : inspected.symbol,
    name: inspected.name === null ? registered.name : inspected.name,
  };
}

/**
 * Resolves both slots to on-chain addresses and stored refs (slot semantics on
 * {@link DvpPartyInput}). Must precede the replay lookup: the fingerprint
 * hashes the resolved addresses. Both lookups are org/project-scoped and
 * active-only, so a foreign or archived reference refuses naming the slot.
 */
async function resolveParties(
  env: Env,
  params: {
    organizationId: string;
    projectId: string;
    partyA: DvpPartyInput;
    partyB: DvpPartyInput;
  }
): Promise<[ResolvedParty, ResolvedParty]> {
  const custodyTargets = new CustodyRuntimeTargets(getDb(env), env, new Map());
  const counterpartyAccounts = createCounterpartyAccountsRepository(
    env,
    createTenantScope({
      organizationId: params.organizationId,
      projectId: params.projectId,
    })
  );

  async function resolveSlot(
    slot: "partyA" | "partyB",
    party: DvpPartyInput
  ): Promise<ResolvedParty> {
    if ("address" in party) {
      return { address: party.address, counterpartyAccountId: null };
    }
    if ("walletId" in party) {
      const wallet = await custodyTargets.findOperationalWalletById({
        organizationId: params.organizationId,
        projectId: params.projectId,
        custodyWalletId: party.walletId,
      });
      if (!wallet) {
        throw badRequest(`${slot}: walletId does not resolve to an active custody wallet in scope`);
      }
      return { address: address(wallet.publicKey), counterpartyAccountId: null };
    }
    const account = await counterpartyAccounts.getCounterpartyAccountByIdInProject({
      counterpartyAccountId: party.counterpartyAccountId,
      organizationId: params.organizationId,
      projectId: params.projectId,
    });
    if (!account) {
      throw badRequest(
        `${slot}: counterpartyAccountId does not resolve to an active account in scope`
      );
    }
    if (account.account_kind !== "crypto_wallet") {
      throw badRequest(`${slot}: counterpartyAccountId must reference a crypto_wallet account`);
    }
    return {
      address: readSolanaCryptoWalletAddress(account.details),
      counterpartyAccountId: account.id,
    };
  }

  return Promise.all([resolveSlot("partyA", params.partyA), resolveSlot("partyB", params.partyB)]);
}

/**
 * Refuses a settlement destination that cannot own the account it will be paid
 * into.
 *
 * Only the ones the caller actually NAMED. A destination equal to its party is
 * the default and has already been proven usable by the party existing, so
 * re-reading it would cost two account fetches on every ordinary trade.
 *
 * Checked before the trade is signed rather than left to settle, because settle
 * moves BOTH legs at once: a destination that cannot own a token account does
 * not fail one side, it strands a trade both parties have already funded.
 */
async function assertNamedDestinationsUsable(
  rpc: ReturnType<typeof solanaRpc.createRpc>,
  input: Pick<CreateDvpTradeInput, "userASettlementDestination" | "userBSettlementDestination">
): Promise<void> {
  const named = [
    { field: "userASettlementDestination", value: input.userASettlementDestination },
    { field: "userBSettlementDestination", value: input.userBSettlementDestination },
  ].flatMap((entry) => (entry.value === null ? [] : [{ ...entry, value: entry.value }]));

  const problems = (
    await Promise.all(
      named.map(async (entry) =>
        (await findDvpDestinationProblem(rpc, entry.value))
          ? describeDvpDestinationProblem(entry.field)
          : null
      )
    )
  ).filter((problem) => problem !== null);

  if (problems.length > 0) {
    throw badRequest(problems.join("; "));
  }
}

/** One leg's on-chain identity, as `readEscrowState` expects it. */
type EscrowLeg = {
  escrow: Address;
  tokenProgram: Address;
  mint: Address;
};

/**
 * The escrows the create transaction just created that sit frozen, empty set
 * when none do or the verdict could not be read.
 *
 * The frozen-default pre-flight (`validateDvpMints`) reads the MINT before the
 * trade is signed, and `DefaultAccountState` only governs accounts created
 * after it changes. So a mint authority flipping the default to frozen between
 * that read and the create landing leaves these escrows frozen at birth: the
 * funding path refuses a frozen escrow, and no settle, cancel or reclaim thaws
 * one — a trade admitted by the pre-flight would be published but fundable by
 * no one. This re-check runs where the rule can no longer race: on the escrow
 * accounts themselves, after the transaction that created them has confirmed.
 *
 * The caller's remedy for a hit is the REFUSAL, not a rewritten row. The trade
 * is on chain — no API status can make it not be — so the row stays on its
 * normal observation and recovery path (`created`, frozen flags recorded, the
 * reconciler watching, funding working again if the freeze authority thaws the
 * escrow), and marking it `create_failed` would orphan a landed trade from
 * both. A keyed retry replays the same trade rather than signing a second one
 * on top. Best effort by design: a failed read skips the check and leaves the
 * trade exactly where the pre-flight world left it. An escrow that reads as
 * absent passes: a create that did not land has no escrow to freeze.
 *
 * @param rpc - Solana RPC to confirm the create and read the escrows from.
 * @param tradeId - The row id, for logs and `readEscrowState` refusals.
 * @param swapDvp - The trade's PDA, which every escrow must name as its owner.
 * @param legs - Both legs' escrow, mint and token program.
 * @param signature - The create transaction's signature, to confirm first.
 * @returns The frozen escrows' addresses.
 */
async function findBornFrozenEscrows(
  rpc: ReturnType<typeof solanaRpc.createRpc>,
  tradeId: string,
  swapDvp: Address,
  legs: readonly EscrowLeg[],
  signature: Signature
): Promise<Address[]> {
  try {
    const confirmation = await solanaRpc.confirmTransaction(rpc, signature, { timeoutMs: 15_000 });
    if (confirmation.err) {
      // The create failed on chain, so there is nothing to admit and the
      // observation below records the failure as it always has.
      return [];
    }
    const states = await Promise.all(
      legs.map((leg) => readEscrowState(rpc, leg, swapDvp, tradeId))
    );
    return legs.filter((_, index) => states[index]?.frozen === true).map((leg) => leg.escrow);
  } catch (error) {
    getLogger().warn(
      { error, tradeId },
      "dvp create: could not verify the escrows were not created frozen; the reconciler keeps watching"
    );
    return [];
  }
}

/**
 * The refusal a born-frozen escrow earns, shared by the create that watches it
 * happen and the keyed retries that would otherwise replay it as a success.
 *
 * A keyed retry of a refused create must answer with the same refusal, not a
 * fresh success: the replay IS the same logical request, and handing it a 201
 * would undo the admission rule the original response enforced.
 *
 * @param tradeId - The trade row id, for the message.
 * @param escrows - The frozen escrow addresses.
 * @returns The conflict error to throw.
 */
function frozenEscrowRefusal(tradeId: string, escrows: readonly Address[]): AppError {
  return conflict(
    `DvP trade ${tradeId}: ${escrows.join(", ")} was created frozen — the mint began defaulting new accounts to frozen between the pre-flight check and the create landing — so no transfer can fund this trade unless the mint's freeze authority thaws ${escrows.join(", ")} first. A new request once the mint no longer defaults accounts to frozen creates a fresh trade.`
  );
}

/**
 * The escrows of a replayed trade that still have no working funding path,
 * empty when the trade is closed, was never refused, or was observed thawed.
 *
 * Only a born-frozen trade — one whose create response the refusal was thrown
 * on, recorded durably by `markBornFrozen` — replays that refusal. The frozen
 * flags are the escrow's current state, refreshed by every observation, so a
 * trade created healthy and frozen by the mint authority later must NOT be
 * read as born-frozen: its first response was a success, and its keyed retry
 * answers with the same trade the first response gave.
 *
 * For a refused trade, a flag that is not affirmatively false keeps the
 * funding path closed. A null — the refusal-time observation failing, or the
 * retry's own refresh failing on the still-unobserved row — must not pass
 * for a trade we KNOW was born frozen: replaying the success it was never
 * given would undo the admission rule. Only an observation recording
 * `frozen = false` reopens it, which is the thaw the refusal message points
 * to; the reconciler records it within a minute and the retry goes through.
 *
 * @param row - The trade row as last observed.
 * @returns The frozen escrows' addresses.
 */
function observedFrozenEscrows(row: DvpTradeRow): Address[] {
  if (row.status !== "creating" && row.status !== "created") {
    return [];
  }
  if (!row.bornFrozen) {
    return [];
  }
  const frozen: Address[] = [];
  if (row.escrowAFrozen !== false) {
    frozen.push(row.escrowA);
  }
  if (row.escrowBFrozen !== false) {
    frozen.push(row.escrowB);
  }
  return frozen;
}

/** What a keyed replay of a live trade answers: the trade, or a retry to make. */
type KeyedReplayVerdict =
  | { action: "return"; trade: DvpTradeRow }
  | { action: "recreate"; failedRowId: string };

/**
 * Answers a keyed retry whose stored row is still alive.
 *
 * A born-frozen refusal threw after the row was written, so a replay can be
 * the SAME logical create that was refused — and it must answer with the
 * refusal, not quietly turn it into a success. The row's own observation is
 * the durable record of the frozen escrow; refreshed here when it is too old
 * to answer with, so a thaw lets the retry through the moment the flags say
 * funding works again.
 *
 * The refresh can also be the read that proves the create transaction expired
 * without ever landing: the row then says `create_failed`, and answering with
 * it would be a 201 for a trade that does not exist. That is the
 * failed-create path, not a replay — the caller frees the key and makes the
 * trade the request always claimed to be.
 *
 * @param env - API process environment.
 * @param replayed - The stored row the key answered with.
 * @param fingerprint - Hash of this request's resolved terms.
 * @returns The trade to answer with, or the failed row whose key to inherit.
 */
async function resolveKeyedReplay(
  env: Env,
  replayed: DvpTradeRow,
  fingerprint: string | null
): Promise<KeyedReplayVerdict> {
  const replay = assertOwnReplay(replayed, fingerprint);
  const current = await observeDvpTradeIfStale(env, replay);
  if (current.status === "create_failed") {
    return { action: "recreate", failedRowId: current.id };
  }
  const frozen = observedFrozenEscrows(current);
  if (frozen.length > 0) {
    throw frozenEscrowRefusal(current.id, frozen);
  }
  return { action: "return", trade: current };
}

/**
 * Creates a DvP trade on chain and records it.
 *
 * @param env - API process environment.
 * @param auditContext - Authenticated initiating request for wallet creation audit.
 * @param input - The trade to create.
 * @returns The persisted trade, including the escrow addresses to publish.
 */
export async function createDvpTrade(
  env: Env,
  auditContext: Context<{ Bindings: Env }>,
  input: CreateDvpTradeInput
): Promise<DvpTradeRow> {
  const repository = createDvpTradeRepository(env);

  // Resolve BOTH parties first: the fingerprint hashes the resolved addresses.
  const [resolvedA, resolvedB] = await resolveParties(env, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    partyA: input.partyA,
    partyB: input.partyB,
  });

  // Before anything else. A retry after an AMBIGUOUS broadcast — a timeout, a
  // dropped socket — is the case this exists for: without it the retry draws a
  // fresh nonce, lands at a different address, and leaves the first trade on
  // chain with a published escrow nobody is watching. Returning the original is
  // the only answer that does not create a second obligation.
  const fingerprint = input.idempotencyKey
    ? dvpCreateFingerprint({ input, resolvedA, resolvedB })
    : null;
  let failedRowId: string | null = null;
  if (input.idempotencyKey) {
    const replayed = await repository.getByIdempotencyKey(input.projectId, input.idempotencyKey);
    if (replayed) {
      if (replayed.status === "create_failed") {
        failedRowId = replayed.id;
      } else {
        const verdict = await resolveKeyedReplay(env, replayed, fingerprint);
        if (verdict.action === "recreate") {
          failedRowId = verdict.failedRowId;
        } else {
          return verdict.trade;
        }
      }
    }
  }

  const mintA = input.mintA;
  const mintB = input.mintB;
  const tokenProgramA = input.tokenProgramA;
  const tokenProgramB = input.tokenProgramB;

  // Mints first, because this needs nothing but the caller's payload. The terms
  // check below cannot run until the signer's address is known, and resolving
  // that signer is a call out to the custody provider — so checking the mints
  // here means a request naming a mint the program refuses costs one batched
  // account read and nothing else. These are the rules `validateDvpTerms`
  // excludes as needing chain state, "handled where the trade is built".
  const rpc = solanaRpc.createRpc(env);
  const mintProblems = await validateDvpMints(rpc, [
    { label: "mintA", mint: mintA, tokenProgram: tokenProgramA },
    { label: "mintB", mint: mintB, tokenProgram: tokenProgramB },
  ]);
  if (mintProblems.length > 0) {
    throw badRequest(`Invalid DvP mints: ${mintProblems.join("; ")}`);
  }

  // Carried onto the row so every later surface can show the trade in the units
  // a person entered. The mints were just read and validated above, so this
  // costs two cached reads rather than a round trip per view — and a mint's
  // decimals cannot change, which is what makes storing them safe at all.
  const [inspectedA, inspectedB] = await Promise.all([
    inspectDvpMint(rpc, mintA),
    inspectDvpMint(rpc, mintB),
  ]);
  const metadataA = storedMintMetadata(inspectedA, wellKnownToken(input.mintA));
  const metadataB = storedMintMetadata(inspectedB, wellKnownToken(input.mintB));

  // Only now, after the payload is known to be sound, do we touch the custody
  // provider. Provisioning happens on first use, so a project's very first
  // trade mints this wallet — and doing that for a request that was going to
  // 400 anyway would leave an unused provider key behind every time.
  const settlement = await getOrCreateDvpSettlementWallet(env, auditContext, {
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  await new CustodyRuntimeTargets(getDb(env), env, new Map()).admitRuntimeExecution({
    organizationId: input.organizationId,
    projectId: input.projectId,
    custodyWalletId: settlement.custodyWalletId,
  });
  const settlementAuthority = settlement.address;

  const userA = resolvedA.address;
  const userB = resolvedB.address;

  // Resolved once, here, and used for the terms check, the row and the ATA
  // derivations alike. The program treats an omitted destination as the party's
  // own address, so mirroring that now means nothing downstream has to branch
  // on null — `settle-atas` can derive an ATA from a column that is always
  // populated.
  const destinationA =
    input.userASettlementDestination === null ? userA : input.userASettlementDestination;
  const destinationB =
    input.userBSettlementDestination === null ? userB : input.userBSettlementDestination;

  await assertNamedDestinationsUsable(rpc, input);

  // Front-run the program's own checks so a bad payload is a 400 naming the
  // field rather than a round trip returning `custom program error: 0x5`.
  const problems = validateDvpTerms(
    {
      userA,
      userB,
      settlementAuthority,
      mintA: input.mintA,
      mintB: input.mintB,
      amountA: input.amountA,
      amountB: input.amountB,
      expiryTimestamp: input.expiryTimestamp,
      earliestSettlementTimestamp: input.earliestSettlementTimestamp,
      refString: input.refString,
      userASettlementDestination: destinationA,
      userBSettlementDestination: destinationB,
    },
    Math.floor(Date.now() / 1000)
  );
  if (problems.length > 0) {
    throw badRequest(`Invalid DvP terms: ${problems.join("; ")}`);
  }

  // Cryptographically random, and a bigint throughout. A predictable nonce lets
  // a third party squat the address before the real parties reach it.
  const nonce = randomDvpNonce();

  const [swapDvp] = await findSwapDvpPda({
    settlementAuthority,
    userA,
    userB,
    mintA,
    mintB,
    nonce,
  });
  const [nonceTombstone, [escrowA], [escrowB]] = await Promise.all([
    findDvpNonceTombstonePda(swapDvp),
    findAssociatedTokenPda({ owner: swapDvp, mint: mintA, tokenProgram: tokenProgramA }),
    findAssociatedTokenPda({ owner: swapDvp, mint: mintB, tokenProgram: tokenProgramB }),
  ]);

  const id = `dvp_${crypto.randomUUID().replace(/-/g, "")}`;
  const recorded = await insertOrReplay(
    repository,
    failedRowId,
    input.idempotencyKey,
    fingerprint,
    {
      id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      swapDvp,
      settlementAuthority,
      userA,
      userB,
      mintA: input.mintA,
      mintB: input.mintB,
      nonce: nonce.toString(),
      tokenProgramA: input.tokenProgramA,
      tokenProgramB: input.tokenProgramB,
      decimalsA: metadataA.decimals,
      decimalsB: metadataB.decimals,
      symbolA: metadataA.symbol,
      symbolB: metadataB.symbol,
      nameA: metadataA.name,
      nameB: metadataB.name,
      amountA: input.amountA.toString(),
      amountB: input.amountB.toString(),
      expiryTimestamp: input.expiryTimestamp.toString(),
      earliestSettlementTimestamp: input.earliestSettlementTimestamp?.toString() ?? null,
      userASettlementDestination: destinationA,
      userBSettlementDestination: destinationB,
      refString: input.refString,
      escrowA,
      escrowB,
      counterpartyAccountIdA: resolvedA.counterpartyAccountId,
      counterpartyAccountIdB: resolvedB.counterpartyAccountId,
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint: fingerprint,
      createSignature: null,
      createLastValidBlockHeight: null,
    }
  );

  if (recorded.id !== id) {
    return recorded;
  }

  // Kora pays the fee and trade-account rent. Resolve sponsorship only after
  // validation and after the durable claim has won the idempotency race.
  let signed = false;
  let createSignature: Signature | null = null;
  try {
    const feePayment = await createProjectSponsorshipFeePayment(env, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      actor: { type: "wallet", id: settlement.custodyWalletId },
    });
    const sponsor = await feePayment.getFeePayer();

    const instruction = getCreateDvpInstruction({
      payer: createNoopSigner(sponsor),
      swapDvp,
      nonceTombstone,
      settlementAuthority,
      userA,
      userB,
      mintA,
      mintB,
      dvpAtaA: escrowA,
      dvpAtaB: escrowB,
      tokenProgramA,
      tokenProgramB,
      amountA: input.amountA,
      amountB: input.amountB,
      expiryTimestamp: input.expiryTimestamp,
      nonce,
      refString: input.refString,
      // Null when the caller named none, which the program records as the party's
      // own address — the default every flow in PRO-1830 wants. An execution desk
      // settling into an account other than the one it funded from passes them.
      userASettlementDestination: input.userASettlementDestination,
      userBSettlementDestination: input.userBSettlementDestination,
      earliestSettlementTimestamp:
        input.earliestSettlementTimestamp === null
          ? none()
          : some(input.earliestSettlementTimestamp),
    });

    const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(
      rpc,
      "confirmed"
    );
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(sponsor, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
      (m) => appendTransactionMessageInstructions([instruction], m)
    );
    const compiled = compileTransaction(message);
    const bytes = new Uint8Array(getTransactionEncoder().encode(compiled));
    createSignature = await submitSponsoredTransaction({
      feePayment,
      rpc,
      transaction: bytes,
      lastValidBlockHeight,
      store: {
        persistSigned: async ({ signature, lastValidBlockHeight: height }) => {
          const attached = await repository.attachCreateSignature(id, signature, height);
          if (attached === null) {
            throw new Error("claim was resolved before its signature could be attached");
          }
          signed = true;
        },
        // The attached signature is DvP's durable in-flight marker: the sweep
        // treats `creating` + signature + height as possibly landed until the
        // height expires. There is no second transition to record here.
        markStarted: async () => {},
        hasStarted: async () => {
          const current = await repository.getById(
            { organizationId: input.organizationId, projectId: input.projectId },
            id
          );
          return current !== null && current.createSignature !== null;
        },
      },
    });
  } catch (error) {
    if (!signed || isDefiniteSubmissionError(error)) {
      await repository.resolveCreate(id, "create_failed");
    }
    throw error;
  }

  const claimed = await repository.getById(
    { organizationId: input.organizationId, projectId: input.projectId },
    id
  );
  if (claimed === null) {
    throw new Error("DvP claim disappeared after sponsored submission");
  }

  // The last leg of the frozen-default admission rule. The pre-flight checked
  // the mint before anything was signed; this checks the escrows the landed
  // create just made, so a mint that flipped its default to frozen in between
  // cannot hand back a "created" trade nobody can fund without saying so.
  // Runs only on a clean submission — an ambiguous send stays at `creating`
  // for the chain to settle, exactly as the catch above leaves it.
  const bornFrozen =
    createSignature === null
      ? []
      : await findBornFrozenEscrows(
          rpc,
          id,
          swapDvp,
          [
            { escrow: escrowA, tokenProgram: tokenProgramA, mint: mintA },
            { escrow: escrowB, tokenProgram: tokenProgramB, mint: mintB },
          ],
          createSignature
        );
  if (bornFrozen.length > 0) {
    // The trade is live on chain, so the row records it as such — status,
    // balances and the frozen flags — and keeps its reconciler and its
    // recovery path. What is refused is this create's RESPONSE: the creator
    // learns the trade cannot be funded, not a success to build on. The
    // refusal is what a keyed retry of this create must replay too, which is
    // what `markBornFrozen` makes replayable: the flags alone cannot tell
    // "refused at birth" from "frozen by the authority later".
    await repository.markBornFrozen(id);
    await observeDvpTradeNow(env, claimed);
    throw frozenEscrowRefusal(id, bornFrozen);
  }

  const observed = await observeDvpTradeNow(env, claimed);
  return observed === null ? claimed : observed;
}
