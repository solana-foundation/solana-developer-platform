/**
 * The token movement builder (ADR 0012): the one place SDP builds the
 * instructions that move a token or native SOL, and the capability decision
 * every movement path asks first.
 *
 * - Native SOL is a system transfer of the quoted debit, in lamports.
 * - A token movement opens the destination's associated token account under
 *   the mint's own program (idempotent, rent from the rent payer), puts a
 *   memo directly before the transfer when the destination requires memos,
 *   and transfers with `TransferCheckedWithFee(debit, decimals, fee)` whenever
 *   the mint has a transfer-fee config, even at 0 bps, so a fee change fails
 *   on chain (`FeeMismatch`) instead of settling short. Otherwise it uses
 *   `TransferChecked`. Never the unchecked `Transfer`.
 * - A hook mint's extra accounts ride the transfer instruction, then the
 *   Solana Pay reference, when there is one, last.
 *
 * Only `resolveTransferHookAccounts` reads the chain, through the caller's
 * client. Everything else is pure and client-safe.
 */

import { MEMO_PROGRAM_ADDRESS } from "@sdp/types/well-known-programs";
import { SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import {
  type AccountMeta,
  AccountRole,
  type Address,
  address,
  fetchEncodedAccount,
  type GetAccountInfoApi,
  getU64Encoder,
  type Instruction,
  isSignerRole,
  type MaybeEncodedAccount,
  type Rpc,
  type TransactionSigner,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  decodeToken,
  deEscalateAccountMeta,
  findAssociatedTokenPda,
  findExtraAccountMetaListPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getExtraAccountMetasDecoder,
  getTokenSize,
  getTransferCheckedInstruction,
  getTransferCheckedWithFeeInstruction,
  isExtension,
  resolveExtraAccountMeta,
} from "@solana-program/token-2022";
import { isSameAsset } from "./asset-ref";
import type { MovementQuote } from "./movement-quote";
import type { BaseUnits } from "./token-amount";
import type { MintTokenTerms, TokenTerms } from "./token-terms";

/**
 * The paths a movement takes, each with its own capability row. PR 4 adds
 * the registered adapters (recurring, issuance, DvP, Private Channels, Earn).
 */
export const TOKEN_MOVEMENT_PATHS = [
  /** Instructions built here: Payments transfers, batches and off-ramp funding. */
  "builder",
] as const;

export type TokenMovementPath = (typeof TOKEN_MOVEMENT_PATHS)[number];

export const TOKEN_MOVEMENT_REFUSALS = {
  nonTransferable: "non_transferable",
  paused: "paused",
  defaultFrozen: "default_frozen",
  hookUnresolved: "hook_unresolved",
  memoRequired: "memo_required",
  nothingCredited: "nothing_credited",
} as const satisfies Record<string, string>;

export type TokenMovementRefusal =
  (typeof TOKEN_MOVEMENT_REFUSALS)[keyof typeof TOKEN_MOVEMENT_REFUSALS];

/** A movement SDP will not build. The message says why, for the caller. */
export class TokenMovementError extends Error {
  readonly reason: TokenMovementRefusal;

  constructor(reason: TokenMovementRefusal, message: string) {
    super(message);
    this.name = "TokenMovementError";
    this.reason = reason;
  }
}

/** Whether a path can move a token under its terms, and why not. */
export type TokenMovementSupport =
  | Readonly<{ supported: true }>
  | Readonly<{ supported: false; refusal: TokenMovementRefusal; message: string }>;

const SUPPORTED: TokenMovementSupport = { supported: true };

function refused(refusal: TokenMovementRefusal, message: string): TokenMovementSupport {
  return { supported: false, refusal, message };
}

/**
 * The builder's row: a transfer fee, a display rule, a permanent delegate and
 * confidential transfers all move through it; a hook moves once its accounts
 * resolve (checked when they are). A mint the program refuses to transfer,
 * and one whose new accounts start frozen (no Token ACL thaw yet), are refused.
 */
function builderSupport(terms: TokenTerms): TokenMovementSupport {
  if (terms.nonTransferable) {
    return refused(
      TOKEN_MOVEMENT_REFUSALS.nonTransferable,
      "This token cannot be transferred: its mint is non-transferable"
    );
  }
  if (terms.paused) {
    return refused(
      TOKEN_MOVEMENT_REFUSALS.paused,
      "This token is paused: its mint refuses every transfer"
    );
  }
  if (terms.defaultAccountState === "frozen") {
    return refused(
      TOKEN_MOVEMENT_REFUSALS.defaultFrozen,
      "This token opens new token accounts frozen, and SDP cannot thaw them"
    );
  }
  return SUPPORTED;
}

/**
 * The capability decision for moving a token under `terms` on `path`. Every
 * path asks it before it reads or builds anything else.
 */
export function support(terms: TokenTerms, path: TokenMovementPath): TokenMovementSupport {
  switch (path) {
    case "builder":
      return builderSupport(terms);
    default: {
      const exhaustive: never = path;
      throw new Error(`Unknown token movement path: ${String(exhaustive)}`);
    }
  }
}

/** A destination token account, as the movement's account read saw it. */
export type DestinationTokenAccount = Readonly<{
  /** The wallet that receives. */
  owner: Address;
  /** The owner's associated token account for the mint, under the mint's program. */
  tokenAccount: Address;
  /** A missing account is created by the movement, and a new account never requires memos. */
  exists: boolean;
  /** Its `MemoTransfer` extension requires a memo on every incoming transfer. */
  requiresMemo: boolean;
}>;

/** The owner's associated token account for the mint, under the mint's program. */
export async function destinationTokenAccountAddress(
  terms: MintTokenTerms,
  owner: Address
): Promise<Address> {
  const [tokenAccount] = await findAssociatedTokenPda({
    owner,
    mint: terms.asset.mint,
    tokenProgram: address(SPL_TOKEN_PROGRAMS[terms.asset.program]),
  });
  return tokenAccount;
}

/**
 * The size of a destination's new associated token account under the mint's
 * terms, which its rent is priced on. A Token-2022 associated account also
 * carries `ImmutableOwner`.
 */
export function associatedTokenAccountSize(terms: MintTokenTerms): number {
  if (terms.asset.program === "spl-token") {
    return getTokenSize();
  }
  const extensions = [{ __kind: "ImmutableOwner" } as const, ...terms.requiredAccountExtensions];
  return getTokenSize(
    extensions.filter(
      (extension, index) =>
        extensions.findIndex((other) => other.__kind === extension.__kind) === index
    )
  );
}

/**
 * Decodes the destination token account a movement read with the mint.
 *
 * @param account - The account at `tokenAccount`, missing or not.
 * @throws {Error} When the account is not the owner's token account of the
 * mint under the mint's program: the caller read the wrong address.
 */
export function decodeDestinationTokenAccount(
  terms: MintTokenTerms,
  owner: Address,
  tokenAccount: Address,
  account: MaybeEncodedAccount
): DestinationTokenAccount {
  if (account.address !== tokenAccount) {
    throw new Error(`Expected the token account ${tokenAccount}, got ${account.address}`);
  }
  if (!account.exists) {
    return { owner, tokenAccount, exists: false, requiresMemo: false };
  }
  if (account.programAddress !== SPL_TOKEN_PROGRAMS[terms.asset.program]) {
    throw new Error(`Token account ${tokenAccount} is not owned by ${terms.asset.program}`);
  }
  const { data } = decodeToken(account);
  if (data.mint !== terms.asset.mint || data.owner !== owner) {
    throw new Error(`Token account ${tokenAccount} is not ${owner}'s account of the mint`);
  }
  const extensions = data.extensions.__option === "Some" ? data.extensions.value : [];
  const requiresMemo = extensions.some(
    (extension) => isExtension("MemoTransfer", extension) && extension.requireIncomingTransferMemos
  );
  return { owner, tokenAccount, exists: true, requiresMemo };
}

/** A transfer's base accounts and amount, as its hook's `Execute` sees them. */
export type HookedTransfer = Readonly<{
  source: Address;
  destination: Address;
  /** The transfer's authority. */
  owner: Address;
  amount: BaseUnits;
}>;

/**
 * `Execute` in `spl-transfer-hook-interface`: the first 8 bytes of
 * sha256("spl-transfer-hook-interface:execute"), then the amount. Seeds that
 * read instruction data read these bytes.
 */
const EXECUTE_DISCRIMINATOR = new Uint8Array([105, 37, 101, 197, 75, 251, 102, 26]);

function executeInstructionData(amount: BaseUnits): Uint8Array {
  const data = new Uint8Array(16);
  data.set(EXECUTE_DISCRIMINATOR, 0);
  data.set(getU64Encoder().encode(amount), 8);
  return data;
}

function accountRole(isSigner: boolean, isWritable: boolean): AccountRole {
  if (isSigner) {
    return isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER;
  }
  return isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;
}

/**
 * The extra accounts each transfer of a hook mint needs, ready to append to
 * its transfer instruction: every configured extra account (resolved and
 * de-escalated against the transfer's base accounts), then the hook program
 * and its validation account. This is `resolveExtraAccountMetasForExecute`
 * from `@solana-program/token-2022`, with the validation account read once
 * for all the transfers instead of once each.
 *
 * RPC budget: none for a mint without a hook program; one `getAccountInfo`
 * for the validation account, plus one read for each extra account whose
 * address comes from another account's data.
 *
 * @returns One list per transfer, in order; empty lists when the mint has no hook program.
 * @throws {TokenMovementError} When the hook program has no validation
 * account, or an extra account must sign: SDP cannot build that transfer.
 */
export async function resolveTransferHookAccounts(
  rpc: Rpc<GetAccountInfoApi>,
  terms: MintTokenTerms,
  transfers: readonly HookedTransfer[]
): Promise<(readonly AccountMeta<Address>[])[]> {
  const hookProgram = terms.transferHookProgram;
  if (hookProgram === null) {
    return transfers.map(() => []);
  }
  const mint = terms.asset.mint;
  const [validation] = await findExtraAccountMetaListPda({ mint }, { programAddress: hookProgram });
  const validationAccount = await fetchEncodedAccount(rpc, validation, {
    commitment: "confirmed",
  });
  if (!validationAccount.exists) {
    throw new TokenMovementError(
      TOKEN_MOVEMENT_REFUSALS.hookUnresolved,
      `This token's transfer hook ${hookProgram} publishes no extra account list, so its transfers cannot be built`
    );
  }
  const extraMetas = getExtraAccountMetasDecoder().decode(validationAccount.data);

  return Promise.all(
    transfers.map(async (transfer) => {
      const instructionData = executeInstructionData(transfer.amount);
      const baseMetas: AccountMeta<Address>[] = [
        transfer.source,
        mint,
        transfer.destination,
        transfer.owner,
        validation,
      ].map((account) => ({ address: account, role: AccountRole.READONLY }));
      const previousAddresses = baseMetas.map((meta) => meta.address);
      const resolved: AccountMeta<Address>[] = [];
      for (const extraMeta of extraMetas) {
        const meta = await resolveExtraAccountMeta(
          extraMeta,
          previousAddresses,
          instructionData,
          hookProgram,
          rpc
        );
        const deEscalated = deEscalateAccountMeta(
          { address: meta.address, role: accountRole(meta.isSigner, meta.isWritable) },
          [...baseMetas, ...resolved]
        );
        if (isSignerRole(deEscalated.role)) {
          throw new TokenMovementError(
            TOKEN_MOVEMENT_REFUSALS.hookUnresolved,
            `This token's transfer hook needs ${meta.address} to sign, which SDP cannot do`
          );
        }
        resolved.push(deEscalated);
        previousAddresses.push(meta.address);
      }
      return [
        ...resolved,
        { address: hookProgram, role: AccountRole.READONLY },
        { address: validation, role: AccountRole.READONLY },
      ];
    })
  );
}

/** The accounts a movement moves between. */
export type TokenMovementAccounts =
  | Readonly<{ kind: "native"; destination: Address }>
  | Readonly<{
      kind: "token";
      /** The token account the authority debits. */
      source: Address;
      destination: DestinationTokenAccount;
      /** From `resolveTransferHookAccounts`; empty for a mint without a hook program. */
      hookAccounts: readonly AccountMeta<Address>[];
    }>;

/** What a movement is built with, besides its terms and quote. */
export type TokenMovementContext = Readonly<{
  /** Signs the transfer: the source wallet. */
  authority: TransactionSigner;
  /**
   * Pays a missing destination token account's rent: the fee payer, as a noop
   * signer when another party signs for it (the sponsor).
   */
  rentPayer: TransactionSigner;
  accounts: TokenMovementAccounts;
  /** Sent directly before the transfer, only when the destination requires memos. */
  memo: string | null;
  /** A Solana Pay reference: read-only on the transfer instruction, after any hook accounts. */
  reference: Address | null;
}>;

type TokenAccounts = Extract<TokenMovementAccounts, { kind: "token" }>;

/** The terms and accounts of one movement, checked to be of the same kind. */
type PairedMovement =
  | Readonly<{ kind: "native"; destination: Address }>
  | Readonly<{ kind: "token"; terms: MintTokenTerms; accounts: TokenAccounts }>;

/**
 * @throws {Error} When the terms and accounts are of different kinds: the
 * caller read the wrong asset.
 */
function pairMovement(terms: TokenTerms, accounts: TokenMovementAccounts): PairedMovement {
  if (terms.readAt === null) {
    if (accounts.kind !== "native") {
      throw new Error("A native SOL movement got token accounts");
    }
    return { kind: "native", destination: accounts.destination };
  }
  if (accounts.kind !== "token") {
    throw new Error("A token movement got native SOL accounts");
  }
  return { kind: "token", terms, accounts };
}

/**
 * Refuses a movement the builder will not build, before anything is signed:
 * the path's capability row, an unresolved hook, a destination that requires
 * a memo the movement does not carry, and a fee that leaves nothing to credit.
 * `buildTokenMovement` asks it first; a caller asks it before it records the
 * movement, so a refusal costs nothing.
 *
 * @throws {TokenMovementError} With the reason the movement is refused.
 * @throws {Error} When the quote, terms and accounts do not belong together.
 */
export function assertMovementBuildable(
  terms: TokenTerms,
  quote: MovementQuote,
  movement: Pick<TokenMovementContext, "accounts" | "memo">
): void {
  if (!isSameAsset(terms.asset, quote.intent.asset)) {
    throw new Error("The quote is for a different asset than the terms");
  }
  const paired = pairMovement(terms, movement.accounts);
  const decision = support(terms, "builder");
  if (!decision.supported) {
    throw new TokenMovementError(decision.refusal, decision.message);
  }
  if (quote.credit === 0n) {
    throw new TokenMovementError(
      TOKEN_MOVEMENT_REFUSALS.nothingCredited,
      "The transfer fee takes the whole amount: the destination would receive nothing"
    );
  }
  if (paired.kind === "native") {
    return;
  }
  const { hookAccounts, destination } = paired.accounts;
  if (paired.terms.transferHookProgram === null && hookAccounts.length > 0) {
    throw new Error("Hook accounts were resolved for a mint without a hook program");
  }
  if (paired.terms.transferHookProgram !== null && hookAccounts.length === 0) {
    throw new TokenMovementError(
      TOKEN_MOVEMENT_REFUSALS.hookUnresolved,
      "This token's transfer hook accounts were not resolved"
    );
  }
  if (destination.requiresMemo && movement.memo === null) {
    throw new TokenMovementError(
      TOKEN_MOVEMENT_REFUSALS.memoRequired,
      `The destination token account ${destination.tokenAccount} requires a memo on incoming transfers; send one`
    );
  }
}

function withTrailingAccounts(
  instruction: Instruction & { accounts: readonly AccountMeta<Address>[] },
  trailing: readonly AccountMeta<Address>[]
): Instruction {
  return trailing.length === 0
    ? instruction
    : { ...instruction, accounts: [...instruction.accounts, ...trailing] };
}

function memoInstruction(memo: string): Instruction {
  return {
    programAddress: MEMO_PROGRAM_ADDRESS,
    accounts: [],
    data: new TextEncoder().encode(memo),
  };
}

/**
 * The instructions that move `quote` under `terms`.
 *
 * @param terms - Token Terms read for the movement; the quote was priced under them.
 * @param quote - Its debit is what the transfer moves; its fee is what a
 * `TransferCheckedWithFee` names.
 * @returns The instructions in order: the destination token account's
 * idempotent create, a memo when the destination requires one, the transfer.
 * Native SOL is the system transfer alone.
 * @throws {TokenMovementError} When {@link assertMovementBuildable} refuses it.
 */
export function buildTokenMovement(
  terms: TokenTerms,
  quote: MovementQuote,
  ctx: TokenMovementContext
): Instruction[] {
  assertMovementBuildable(terms, quote, ctx);
  const reference: AccountMeta<Address>[] =
    ctx.reference === null ? [] : [{ address: ctx.reference, role: AccountRole.READONLY }];
  const paired = pairMovement(terms, ctx.accounts);

  if (paired.kind === "native") {
    return [
      withTrailingAccounts(
        getTransferSolInstruction({
          source: ctx.authority,
          destination: paired.destination,
          amount: quote.debit,
        }),
        reference
      ),
    ];
  }

  const { terms: mintTerms, accounts } = paired;
  const mint = mintTerms.asset.mint;
  const programAddress = address(SPL_TOKEN_PROGRAMS[mintTerms.asset.program]);
  const { destination } = accounts;
  const transferInput = {
    source: accounts.source,
    mint,
    destination: destination.tokenAccount,
    authority: ctx.authority,
    amount: quote.debit,
    decimals: mintTerms.decimals,
  };
  const transfer =
    mintTerms.transferFee === null
      ? getTransferCheckedInstruction(transferInput, { programAddress })
      : getTransferCheckedWithFeeInstruction(
          { ...transferInput, fee: quote.fee },
          { programAddress }
        );
  const memo = destination.requiresMemo && ctx.memo !== null ? [memoInstruction(ctx.memo)] : [];

  return [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: ctx.rentPayer,
      ata: destination.tokenAccount,
      owner: destination.owner,
      mint,
      tokenProgram: programAddress,
    }),
    ...memo,
    withTrailingAccounts(transfer, [...accounts.hookAccounts, ...reference]),
  ];
}
