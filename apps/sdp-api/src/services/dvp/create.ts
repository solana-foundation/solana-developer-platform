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
  getBase64Encoder,
  getTransactionEncoder,
  none,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  some,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { getDb } from "@/db";
import {
  createCounterpartyAccountsRepository,
  createDvpTradeRepository,
  type DvpTradeRow,
} from "@/db/repositories";
import { badRequest, conflict } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { readSolanaCryptoWalletAddress } from "@/services/payments/counterparty-account-resolution";
import {
  assertSponsorSignedSameMessage,
  createProjectSponsorshipFeePayment,
} from "@/services/sponsorship.service";
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
import { observeDvpTradeNow } from "./observe-now";
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
 * The catalogue's symbol for a mint, or null.
 *
 * The fallback for mints that carry no metadata of their own, which is every
 * legacy SPL token including the stablecoins most cash legs use.
 */
function wellKnownSymbol(mint: string): string | null {
  return WELL_KNOWN_TOKEN_BY_MINT.get(mint)?.symbol ?? null;
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

/**
 * Creates a DvP trade on chain and records it.
 *
 * @param env - API process environment.
 * @param input - The trade to create.
 * @returns The persisted trade, including the escrow addresses to publish.
 */
export async function createDvpTrade(env: Env, input: CreateDvpTradeInput): Promise<DvpTradeRow> {
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
        return assertOwnReplay(replayed, fingerprint);
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

  // Only now, after the payload is known to be sound, do we touch the custody
  // provider. Provisioning happens on first use, so a project's very first
  // trade mints this wallet — and doing that for a request that was going to
  // 400 anyway would leave an unused provider key behind every time.
  const settlement = await getOrCreateDvpSettlementWallet(env, {
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  const settlementAuthority = settlement.address;

  const userA = resolvedA.address;
  const userB = resolvedB.address;

  // Resolved once, here, and used for the terms check, the row and the ATA
  // derivations alike. The program treats an omitted destination as the party's
  // own address, so mirroring that now means nothing downstream has to branch
  // on null — `settle-preflight` can derive an ATA from a column that is always
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
      decimalsA: inspectedA?.decimals ?? null,
      decimalsB: inspectedB?.decimals ?? null,
      symbolA: inspectedA?.symbol ?? wellKnownSymbol(input.mintA),
      symbolB: inspectedB?.symbol ?? wellKnownSymbol(input.mintB),
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
    await submitSponsoredTransaction({
      feePayment,
      rpc,
      transaction: bytes,
      lastValidBlockHeight,
      store: {
        persistSigned: async ({ signature, signedTransaction, lastValidBlockHeight: height }) => {
          assertSponsorSignedSameMessage({
            unsignedOrPartiallySigned: compiled,
            sponsorSigned: new Uint8Array(getBase64Encoder().encode(signedTransaction)),
            sponsor,
          });
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
  const observed = await observeDvpTradeNow(env, claimed);
  return observed === null ? claimed : observed;
}
