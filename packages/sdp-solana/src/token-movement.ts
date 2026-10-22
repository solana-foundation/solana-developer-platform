/**
 * The token movement builder (ADR 0012): the one place SDP builds the
 * instructions that move a token or native SOL, and the capability decision
 * every movement path asks first (`support`, one row per path: the builder's
 * and each registered adapter's).
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

import type { TokenMovementRefusalReason } from "@sdp/types/token-movements";
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
import { type BaseUnits, toTokenAmount } from "./token-amount";
import {
  epochFee,
  feeFor,
  type MintTokenTerms,
  type TokenTerms,
  type TransferFeeRate,
} from "./token-terms";

/**
 * The paths a movement takes, each with its own capability row (ADR 0012,
 * "one capability decision"). `builder` is the instructions built here; the
 * others are registered adapters: each moves tokens through its own engine
 * (an SDK or an on-chain program), so its row holds that engine's rules.
 */
export const TOKEN_MOVEMENT_PATHS = [
  /** Instructions built here: Payments transfers, batches, off-ramp funding, /pay and DvP funding. */
  "builder",
  // ── Registered adapters ────────────────────────────────────────────────
  /**
   * A recurring pull: the subscriptions program moves the mandate's debit with
   * a plain `TransferChecked` through CPI, so no fee guard is on chain and the
   * destination cannot get a memo first.
   */
  "recurring",
  /** Issuance mint and burn through Mosaic. Neither is a transfer, so no fee or hook applies. */
  "issuance",
  /** Issuance seize: the permanent delegate's `TransferChecked`, which Mosaic builds. */
  "issuance_seize",
  /** DvP trades: the DvP program settles, cancels and reclaims each escrow. */
  "dvp",
  /** Private Channels deposits, transfers and withdrawals, through SPC's escrow and encoding. */
  "private_channels",
  /**
   * Earn deposit mints, moved by each provider's own builder or program. Exits
   * never inherit a money-in gate; the deposit-mint guard reports this row.
   */
  "earn",
] as const;

export type TokenMovementPath = (typeof TOKEN_MOVEMENT_PATHS)[number];

export const TOKEN_MOVEMENT_REFUSALS = {
  nonTransferable: "non_transferable",
  paused: "paused",
  defaultFrozen: "default_frozen",
  hookUnresolved: "hook_unresolved",
  memoRequired: "memo_required",
  nothingCredited: "nothing_credited",
  feeAboveTolerance: "fee_above_tolerance",
  /** An existing destination token account is frozen. */
  destinationFrozen: "destination_frozen",
  // ── The adapters' rows ─────────────────────────────────────────────────
  /** The path cannot state a transfer fee, or cannot carry one. */
  transferFee: "transfer_fee",
  /** The path's program refuses a scaled or interest-bearing mint. */
  displayRule: "display_rule",
  /** The path cannot pass a transfer hook's extra accounts. */
  transferHook: "transfer_hook",
} as const satisfies Record<string, TokenMovementRefusalReason>;

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

/**
 * What a path does with a movement it will not make now. A `hold` may pass
 * later without anything SDP stores changing (a paused mint can be unpaused),
 * so a path that can wait, a recurring pull, waits instead of failing; a
 * `refuse` cannot.
 */
export type TokenMovementDisposition = "refuse" | "hold";

/** Whether a path can move a token under its terms, and why not. */
export type TokenMovementSupport =
  | Readonly<{ supported: true }>
  | Readonly<{
      supported: false;
      refusal: TokenMovementRefusal;
      message: string;
      disposition: TokenMovementDisposition;
    }>;

/** The Token-2022 mint extension, as the client names it, whose state a row refuses. */
export type CapabilityExtension =
  | "NonTransferable"
  | "PausableConfig"
  | "DefaultAccountState"
  | "TransferFeeConfig"
  | "ScaledUiAmountConfig"
  | "InterestBearingConfig"
  | "TransferHook";

/** One reason a path refuses, or holds, a mint. */
export type TokenMovementRefusalNotice = Readonly<{
  refusal: TokenMovementRefusal;
  extension: CapabilityExtension;
  message: string;
  disposition: TokenMovementDisposition;
}>;

/** One cell of a capability row: a mint state the path cannot move, or null. */
type CapabilityRule = (terms: TokenTerms) => TokenMovementRefusalNotice | null;

const SUPPORTED: TokenMovementSupport = { supported: true };

function held(refusal: TokenMovementRefusal, message: string): TokenMovementSupport {
  return { supported: false, refusal, message, disposition: "hold" };
}

function notice(
  refusal: TokenMovementRefusal,
  extension: CapabilityExtension,
  message: string
): TokenMovementRefusalNotice {
  return { refusal, extension, message, disposition: "refuse" };
}

const nonTransferable: CapabilityRule = (terms) =>
  terms.nonTransferable
    ? notice(
        TOKEN_MOVEMENT_REFUSALS.nonTransferable,
        "NonTransferable",
        "This token cannot be transferred: its mint is non-transferable"
      )
    : null;

/** Token-2022 refuses every transfer, mint and burn of a paused mint. */
const paused: CapabilityRule = (terms) =>
  terms.paused
    ? notice(
        TOKEN_MOVEMENT_REFUSALS.paused,
        "PausableConfig",
        "This token is paused: its mint refuses every transfer, mint and burn"
      )
    : null;

/** The same, for a path that can wait: it holds the movement until the mint is unpaused. */
const pausedHolds: CapabilityRule = (terms) =>
  terms.paused
    ? {
        refusal: TOKEN_MOVEMENT_REFUSALS.paused,
        extension: "PausableConfig",
        message: "This token is paused: its mint refuses every transfer until it is unpaused",
        disposition: "hold",
      }
    : null;

/** Any frozen-by-default mint, for an engine that cannot thaw the accounts it opens. */
function frozenByDefault(engine: string): CapabilityRule {
  return (terms) =>
    terms.defaultAccountState === "frozen"
      ? notice(
          TOKEN_MOVEMENT_REFUSALS.defaultFrozen,
          "DefaultAccountState",
          `This token opens new token accounts frozen, and ${engine} cannot thaw them`
        )
      : null;
}

/** A fee config, even at 0 bps, for an engine that cannot state the fee it would pay. */
function feeConfig(engine: string): CapabilityRule {
  return (terms) =>
    terms.transferFee === null
      ? null
      : notice(
          TOKEN_MOVEMENT_REFUSALS.transferFee,
          "TransferFeeConfig",
          `This token has a transfer fee config, which ${engine} cannot carry`
        );
}

function charges(rate: TransferFeeRate): boolean {
  return rate.basisPoints > 0 && rate.maximumFee > 0n;
}

/**
 * A fee that is charged now or is set to be: the entry in force at the read,
 * or the newer one. A zero fee config (PYUSD, USDG) passes; a plain
 * `TransferChecked` under it credits the whole debit.
 */
function chargedFee(engine: string): CapabilityRule {
  return (terms) => {
    if (terms.transferFee === null || terms.readAt === null) {
      return null;
    }
    const current = epochFee(terms, terms.readAt.epoch);
    const charged = (current !== null && charges(current)) || charges(terms.transferFee.newer);
    return charged
      ? notice(
          TOKEN_MOVEMENT_REFUSALS.transferFee,
          "TransferFeeConfig",
          `This token charges a transfer fee, which ${engine} cannot carry`
        )
      : null;
  };
}

/** A scaled or interest-bearing mint, for a program that refuses both. */
function displayRule(engine: string): CapabilityRule {
  return (terms) => {
    switch (terms.display.kind) {
      case "plain":
        return null;
      case "scaled":
        return notice(
          TOKEN_MOVEMENT_REFUSALS.displayRule,
          // biome-ignore lint/security/noSecrets: an extension name, not a secret.
          "ScaledUiAmountConfig",
          `This token has a scaled UI amount, which ${engine} refuses`
        );
      case "interest":
        return notice(
          TOKEN_MOVEMENT_REFUSALS.displayRule,
          "InterestBearingConfig",
          `This token bears interest, which ${engine} refuses`
        );
      default: {
        const exhaustive: never = terms.display;
        throw new Error(`Unknown display rule: ${JSON.stringify(exhaustive)}`);
      }
    }
  };
}

/** A hook program that runs on every transfer, for an engine that cannot pass its accounts. */
function hookSet(engine: string): CapabilityRule {
  return (terms) =>
    terms.transferHookProgram === null
      ? null
      : notice(
          TOKEN_MOVEMENT_REFUSALS.transferHook,
          "TransferHook",
          `This token runs a transfer hook, which ${engine} cannot pass accounts to`
        );
}

/**
 * A hook program that runs, or that its authority can set later: an engine
 * that holds funds across transfers (an escrow) is stranded if one appears.
 * An immutable hook with no program can never run.
 */
function hookSettable(engine: string): CapabilityRule {
  return (terms) =>
    terms.transferHookProgram === null && terms.transferHookAuthority === null
      ? null
      : notice(
          TOKEN_MOVEMENT_REFUSALS.transferHook,
          "TransferHook",
          `This token has a transfer hook that runs or can be set, which ${engine} cannot pass accounts to`
        );
}

/**
 * The capability table: per path, the mint states it refuses, in the order
 * they are reported. A state no rule names moves on that path. Rows come from
 * SDP's own rules and from each path's engine:
 *
 * | State | builder | recurring | issuance | issuance_seize | dvp | private_channels | earn |
 * |---|---|---|---|---|---|---|---|
 * | Transfer fee | yes (`TransferCheckedWithFee`) | yes, within the mandate's tolerance (`recurringPullSupport`) | n/a | yes: the seized amount is the debit, the fee is withheld in the destination | program refuses | refused (SPC cannot encode `WithFee`) | refused once a fee is charged; a 0-bps config moves |
 * | Scaled / interest | yes (display only) | yes | yes | yes | program refuses | yes | yes |
 * | Hook | yes once its accounts resolve | yes | n/a | refused when a program is set | refused when it runs or can be set | refused when it runs or can be set | refused when a program is set |
 * | Paused | refused | held until unpaused | refused | refused | refused | refused | refused |
 * | Non-transferable | refused | refused | yes | refused | program refuses | refused | refused |
 * | Frozen by default | refused | refused | yes (Mosaic thaws Token ACL accounts) | yes (same) | yes (funding refuses a frozen escrow) | refused | refused |
 * | Permanent delegate, confidential | yes | yes | yes | yes | yes | yes | yes |
 *
 * Every refusal is a `refuse` except the recurring row's paused mint, a
 * `hold`: a recurring pull can wait for the mint to be unpaused. A row lists
 * its refusals before its holds, so a mint that can never move is refused.
 * `builder` agrees with the Kora sponsor policy (`infra/kora/kora.toml`,
 * pinned by `kora-sponsor-policy.test.ts`); `dvp` is the DvP program's
 * `validate_mint_extensions` plus what SDP cannot settle, cancel or reclaim.
 */
const CAPABILITY_ROWS = {
  builder: [nonTransferable, paused, frozenByDefault("SDP")],
  recurring: [nonTransferable, frozenByDefault("a recurring pull"), pausedHolds],
  issuance: [paused],
  issuance_seize: [nonTransferable, paused, hookSet("Mosaic's force transfer")],
  dvp: [
    feeConfig("the DvP program"),
    displayRule("the DvP program"),
    nonTransferable,
    hookSettable("DvP settlement"),
    paused,
  ],
  private_channels: [
    nonTransferable,
    paused,
    frozenByDefault("Private Channels"),
    feeConfig("Private Channels"),
    hookSettable("Private Channels"),
  ],
  earn: [nonTransferable, paused, frozenByDefault("Earn"), chargedFee("Earn"), hookSet("Earn")],
} as const satisfies Record<TokenMovementPath, readonly CapabilityRule[]>;

/**
 * Every reason `path` refuses to move a token under `terms`, in its row's
 * order; empty when it moves. For a caller that reports them all at once.
 */
export function capabilityRefusals(
  terms: TokenTerms,
  path: TokenMovementPath
): readonly TokenMovementRefusalNotice[] {
  const rules: readonly CapabilityRule[] = CAPABILITY_ROWS[path];
  return rules.flatMap((rule) => {
    const refusal = rule(terms);
    return refusal === null ? [] : [refusal];
  });
}

/**
 * The capability decision for moving a token under `terms` on `path`: its
 * first refusal, or supported. Every path asks it before it reads or builds
 * anything else.
 */
export function support(terms: TokenTerms, path: TokenMovementPath): TokenMovementSupport {
  const [first] = capabilityRefusals(terms, path);
  return first === undefined
    ? SUPPORTED
    : {
        supported: false,
        refusal: first.refusal,
        message: first.message,
        disposition: first.disposition,
      };
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

/** What one recurring pull moves under its mandate, in base units. */
export type RecurringPull = Readonly<{
  /** The mandate's debit: what the subscriptions program pulls. */
  debit: BaseUnits;
  /** The fee tolerance the mandate recorded: the largest fee one pull may pay. */
  maxFeePerPull: BaseUnits;
}>;

/**
 * The transfer fee one recurring pull of `debit` may pay under `terms`: the
 * larger of the read's epoch fee and the next epoch's. A fee change takes
 * effect at an epoch boundary, and a pull read at the end of an epoch may
 * land in the next one, where the program's `TransferChecked` withholds the
 * new fee with no guard.
 */
export function recurringPullFee(terms: MintTokenTerms, debit: BaseUnits): BaseUnits {
  const { epoch } = terms.readAt;
  const current = feeFor(terms, debit, epoch);
  const next = feeFor(terms, debit, epoch + 1n);
  return next > current ? next : current;
}

/**
 * The decision for one recurring pull under `terms`: the recurring row, then
 * the destination and the fee. Every outcome but a non-transferable or
 * frozen-by-default mint is a hold, which can pass on a later read.
 *
 * - A destination that requires memos holds the pull: a CPI cannot put a memo
 *   first.
 * - A fee ({@link recurringPullFee}) above the mandate's tolerance holds it.
 * - A fee that takes the whole debit holds it.
 *
 * @param destination - The destination token account, as the pull's read saw it.
 */
export function recurringPullSupport(
  terms: MintTokenTerms,
  pull: RecurringPull,
  destination: DestinationTokenAccount
): TokenMovementSupport {
  const decision = support(terms, "recurring");
  if (!decision.supported) {
    return decision;
  }
  if (destination.requiresMemo) {
    return held(
      TOKEN_MOVEMENT_REFUSALS.memoRequired,
      `The destination token account ${destination.tokenAccount} requires a memo on incoming transfers, which a recurring pull cannot send`
    );
  }
  const fee = recurringPullFee(terms, pull.debit);
  if (fee > pull.maxFeePerPull) {
    const units = (amount: BaseUnits) => toTokenAmount(amount, terms.decimals).value;
    return held(
      TOKEN_MOVEMENT_REFUSALS.feeAboveTolerance,
      `This token's transfer fee on one pull is ${units(fee)}, above the ${units(pull.maxFeePerPull)} the recurring payment tolerates`
    );
  }
  if (fee === pull.debit) {
    return held(
      TOKEN_MOVEMENT_REFUSALS.nothingCredited,
      "The transfer fee takes the whole pull: the destination would receive nothing"
    );
  }
  return SUPPORTED;
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
