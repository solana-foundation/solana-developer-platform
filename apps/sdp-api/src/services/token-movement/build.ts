/**
 * Payments token movements (ADR 0012): every Payments transfer, batch and
 * off-ramp deposit is planned here before anything is recorded, and built
 * through `buildTokenMovement` (`@sdp/solana/token-movement`), the only
 * constructor of token transfer instructions, once a signer and a fee payer
 * exist.
 *
 * Planning reads the terms, the destination token accounts and the source,
 * asks the capability decision, quotes each destination and resolves hook
 * accounts. So every refusal (a paused or non-transferable mint, an unresolved
 * hook, a missing memo, too many decimals, a fee that takes everything) is a
 * 400 raised before the movement row exists, and its Idempotency-Key is never
 * spent on it.
 *
 * RPC budget per movement (before this module → now):
 * - a token movement: the mint read and the source accounts read → the same
 *   two. The mint read now carries the Clock and the destination token
 *   accounts (concurrent pages past 100 accounts); for a catalogue mint the
 *   two reads run at once.
 * - a hook mint: + one read of the hook's validation account for the whole
 *   movement, + one per distinct account whose data an extra account's
 *   address or seeds read, shared by every destination.
 * - native SOL: none → none.
 */

import { createClusterRpc } from "@sdp/rpc/factory";
import { AmountError } from "@sdp/solana/amount";
import type { AssetRequest } from "@sdp/solana/asset-ref";
import { type MovementQuote, quoteMovement } from "@sdp/solana/movement-quote";
import { parseTokenAmount } from "@sdp/solana/token-amount";
import {
  assertMovementBuildable,
  buildTokenMovement,
  resolveTransferHookAccounts,
  support,
  type TokenMovementAccounts,
  TokenMovementError,
} from "@sdp/solana/token-movement";
import { NATIVE_TOKEN_TERMS, type TokenTerms } from "@sdp/solana/token-terms";
import type { TokenMovementBasis } from "@sdp/types/token-movements";
import { SPL_TOKEN_PROGRAMS, type TokenProgramKind } from "@sdp/types/well-known-tokens";
import {
  type Address,
  address,
  createNoopSigner,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { badRequest } from "@/lib/errors";
import {
  resolveSourceTokenAccount,
  type SourceTokenAccount,
} from "@/routes/payments/token-accounts";
import { readMintMovementAccounts } from "./read-terms";

/** One destination of a movement, with the amount its request names. */
export interface MovementDestination {
  owner: Address;
  /** A token-unit decimal string, as the request sent it. */
  amount: string;
}

/** One destination's quote and the accounts its transfer moves between. */
export type PlannedLeg = Readonly<{ quote: MovementQuote; accounts: TokenMovementAccounts }>;

/** A movement read, gated and quoted, ready to record and then build. */
export type PlannedTokenMovement = Readonly<{
  terms: TokenTerms;
  /** The source token account the movement debits; null for native SOL. */
  source: SourceTokenAccount | null;
  /** One leg per destination, in request order. */
  legs: readonly PlannedLeg[];
  /** Sent before each transfer whose destination requires memos. */
  memo: string | null;
}>;

/** Runs a planning step, answering its refusals as 400s. */
function refusedAsBadRequest<T>(step: () => T): T {
  try {
    return step();
  } catch (error) {
    if (error instanceof TokenMovementError) {
      throw badRequest(error.message, { reason: error.reason });
    }
    if (error instanceof AmountError) {
      throw badRequest(error.message);
    }
    throw error;
  }
}

/** {@link refusedAsBadRequest} for a step that reads the chain. */
async function refusedAsBadRequestAsync<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof TokenMovementError) {
      throw badRequest(error.message, { reason: error.reason });
    }
    throw error;
  }
}

function quoteDestination(
  terms: TokenTerms,
  destination: MovementDestination,
  basis: TokenMovementBasis
): MovementQuote {
  return refusedAsBadRequest(() =>
    quoteMovement(terms, {
      asset: terms.asset,
      amount: parseTokenAmount(destination.amount, terms.decimals),
      basis,
    })
  );
}

/**
 * A transfer into the account it leaves moves nothing, so it is refused
 * rather than recorded as moved.
 */
function refuseSelfTransfer(source: Address, destination: Address): void {
  if (source === destination) {
    throw badRequest("The destination is the source account: the transfer would move nothing");
  }
}

/**
 * Reads, gates and quotes a movement from `source` to each destination, on
 * the open cluster scope.
 *
 * @param input.asset - The resolved request asset.
 * @param input.basis - Which side of each transfer the amounts fix.
 * @param input.source - The wallet that signs and pays.
 * @param input.memo - The movement's memo, sent where a destination requires one.
 * @throws AppError (400) for every refusal: an unreadable mint, the
 * capability decision, no source token account, an amount the mint cannot
 * hold, a fee that leaves nothing, an unresolved hook, a missing memo, or a
 * destination that is the source account.
 */
export async function planTokenMovement(input: {
  asset: AssetRequest;
  basis: TokenMovementBasis;
  source: Address;
  destinations: readonly MovementDestination[];
  memo: string | null;
}): Promise<PlannedTokenMovement> {
  if (input.asset.kind === "native") {
    const terms = NATIVE_TOKEN_TERMS;
    const legs = input.destinations.map((destination) => {
      refuseSelfTransfer(input.source, destination.owner);
      const quote = quoteDestination(terms, destination, input.basis);
      const accounts: TokenMovementAccounts = { kind: "native", destination: destination.owner };
      refusedAsBadRequest(() =>
        assertMovementBuildable(terms, quote, { accounts, memo: input.memo })
      );
      return { quote, accounts };
    });
    return { terms, source: null, legs, memo: input.memo };
  }

  const mint = input.asset.mint;
  const readSource = (program: TokenProgramKind) =>
    resolveSourceTokenAccount(input.source, mint, address(SPL_TOKEN_PROGRAMS[program]));
  // A catalogue mint names its program, so its source read need not wait.
  const [read, knownSource] = await Promise.all([
    readMintMovementAccounts(
      input.asset,
      input.destinations.map((destination) => destination.owner)
    ),
    input.asset.kind === "token" ? readSource(input.asset.program) : null,
  ]);
  const { terms } = read;
  const decision = support(terms, "builder");
  if (!decision.supported) {
    throw badRequest(decision.message, { reason: decision.refusal });
  }
  const source = knownSource === null ? await readSource(terms.asset.program) : knownSource;
  for (const destination of read.destinations) {
    refuseSelfTransfer(source.tokenAccount, destination.tokenAccount);
  }
  const quotes = input.destinations.map((destination) =>
    quoteDestination(terms, destination, input.basis)
  );
  const hookAccounts = await refusedAsBadRequestAsync(() =>
    resolveTransferHookAccounts(
      createClusterRpc(),
      terms,
      read.destinations.map((destination, index) => ({
        source: source.tokenAccount,
        destination: destination.tokenAccount,
        owner: input.source,
        amount: quotes[index].debit,
      }))
    )
  );
  const legs = quotes.map((quote, index) => {
    const accounts: TokenMovementAccounts = {
      kind: "token",
      source: source.tokenAccount,
      destination: read.destinations[index],
      hookAccounts: hookAccounts[index],
    };
    refusedAsBadRequest(() =>
      assertMovementBuildable(terms, quote, { accounts, memo: input.memo })
    );
    return { quote, accounts };
  });
  return { terms, source, legs, memo: input.memo };
}

/**
 * The instructions of one planned leg, signed by `authority`, with any
 * missing destination token account's rent paid by the fee payer.
 */
export function buildPlannedLeg(
  plan: PlannedTokenMovement,
  leg: PlannedLeg,
  ctx: { authority: TransactionSigner; feePayer: Address }
): Instruction[] {
  return refusedAsBadRequest(() =>
    buildTokenMovement(plan.terms, leg.quote, {
      authority: ctx.authority,
      rentPayer: createNoopSigner(ctx.feePayer),
      accounts: leg.accounts,
      memo: plan.memo,
      reference: null,
    })
  );
}
