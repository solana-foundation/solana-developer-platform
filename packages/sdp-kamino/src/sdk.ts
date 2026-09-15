import {
  getKvaultGlobalConfigPda,
  KaminoReserve,
  KaminoVault,
  KaminoVaultClient,
  KVaultGlobalConfig,
  Reserve,
} from "@kamino-finance/klend-sdk";
import { formatDecimalAmount, isDecimalString, parseDecimalAmount } from "@sdp/solana/amount";
import type { Address, Instruction } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import Decimal from "decimal.js";
import { acceptAtMintScale, isZeroAmount, mintDecimals } from "./amounts";
import { vaultAssetIdentityFromState } from "./asset-identity";
import { invalidAmount, SdpKaminoError, vaultUnreadable } from "./errors";
import { assertPlanTargetsCluster } from "./guards";
import { loadVaultLookupTableAddresses } from "./lookup-table";
import { kaminoClusterConfig } from "./programs";
import {
  deriveKaminoDepositQuote,
  deriveKaminoWithdrawQuote,
  type KaminoDepositQuote,
  type KaminoDepositQuoteInput,
  type KaminoWithdrawQuote,
  type KaminoWithdrawQuoteInput,
} from "./quotes";
import { createKaminoRpc } from "./rpc";
import { parseShareTokenAccountBalances, sumRawTokenAccountBaseUnits } from "./share-balances";
import type {
  KaminoDepositInput,
  KaminoInstructionPlan,
  KaminoPosition,
  KaminoRuntime,
  KaminoWithdrawInput,
} from "./types";
import {
  buildMaximumWithdrawalBalanceGuard,
  buildShareAccountCloseInstruction,
  buildShareAccountConsolidation,
  decodeKvaultWithdrawShares,
  isShareAtaCloseInstruction,
  type RoleTaggedInstruction,
  resolveBurnAllSentinel,
} from "./withdraw-instructions";

/**
 * ════════════════════════════════════════════════════════════════════════════
 *  THE KIT-VERSION FIREWALL. This is the ONLY module in the package — source or
 *  test — that may import `@kamino-finance/klend-sdk` or `decimal.js`.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * klend-sdk is built against `@solana/kit` **^2.3.0**; this repo pins **6.8.0**.
 * Both copies coexist in the tree (pnpm nests the SDK's own). Verified by a live
 * round trip on 2026-08-15: instructions come back as plain objects with a
 * numeric `AccountRole` and `Uint8Array` data, and kit 6.8 compiles and signs
 * them unchanged — so the boundary is real at the TYPE level but inert at
 * RUNTIME. Every cast below is therefore a structural re-label, not a coercion,
 * and each is annotated with what makes it safe.
 *
 * Keeping the SDK behind this one module is also what keeps the 13MB dependency
 * out of `@sdp/earn`, whose catalogue cron runs hourly in both environments and
 * never builds a transaction.
 */

/** klend-sdk's kit-2 surface, as far as this module needs to name it. */
// biome-ignore lint/suspicious/noExplicitAny: the kit-2 <-> kit-6.8 seam; see the header.
type Kit2 = any;
type AssertActive = () => void;
const alwaysActive: AssertActive = () => undefined;

/**
 * Bind a vault so that READS AND WRITES USE THE SAME PROGRAM. Every entry point
 * in this file goes through here; nothing else may construct a vault.
 *
 * ── The trap, stated once ───────────────────────────────────────────────────
 * `new KaminoVault(rpc, addr, state, programId)` looks like it binds the vault
 * to `programId`, and it half does: the id is used to FETCH `VaultState`, then
 * the constructor builds its own `KaminoVaultClient` **without forwarding it**.
 * Instruction building goes through that internal client, which defaults to
 * MAINNET. On devnet the result is a vault that reads `devkRng…` state and emits
 * instructions addressed to `KvauGM…` — silently, with no error.
 *
 * Kamino's own published recipe uses exactly that constructor, so this is the
 * default outcome for anyone following the docs. `loadWithClientAndState` is the
 * only factory that sets `vault.programId` AND `vault.client` together.
 *
 * `assertPlanTargetsCluster` independently re-checks the OUTPUT, because this
 * function's correctness is a convention inside one call and that assertion is a
 * property of what we actually emit.
 */
function createVaultClient(runtime: KaminoRuntime) {
  const config = kaminoClusterConfig(runtime.cluster);
  // The transport deadline covers both our direct reads and every nested
  // reserve/farm/vault request klend-sdk performs with this same client.
  const rpc = createKaminoRpc(runtime.rpcUrl) as Kit2;

  const client = new KaminoVaultClient(
    rpc,
    config.slotDurationMs,
    config.kvaultProgramId as Kit2,
    config.klendProgramId as Kit2,
    undefined,
    config.farmsProgramId as Kit2
  );

  return { client, config, rpc };
}

async function bindVault(
  runtime: KaminoRuntime,
  vaultAddress: Address,
  assertActive: AssertActive = alwaysActive
) {
  assertActive();
  const { client, config, rpc } = createVaultClient(runtime);

  // The probe exists only to fetch state under the right program id; it is never
  // used to build anything.
  const probe = new KaminoVault(
    rpc,
    vaultAddress as Kit2,
    undefined,
    config.kvaultProgramId as Kit2,
    config.slotDurationMs
  );

  let state: Kit2;
  try {
    state = await probe.getState();
  } catch (cause) {
    throw vaultUnreadable(vaultAddress, runtime.cluster, cause);
  }
  assertActive();

  const vault = KaminoVault.loadWithClientAndState(client, vaultAddress as Kit2, state);
  if (String(vault.programId) !== String(config.kvaultProgramId)) {
    // Unreachable unless the SDK changes `loadWithClientAndState`. Cheap to
    // assert, and the failure it guards is invisible otherwise.
    throw vaultUnreadable(vaultAddress, runtime.cluster, "vault bound to the wrong kvault program");
  }

  // Bind the asset identity to the same live state snapshot used for decimals,
  // reserve loading and instruction construction. The API compares these
  // builder-observed mints with catalogue metadata before it signs anything.
  const assetIdentity = vaultAssetIdentityFromState(state);
  return { client, vault, state, config, rpc, assetIdentity };
}

/**
 * Load reserve account state without requiring a price oracle.
 *
 * klend-sdk's `loadVaultReserves` always resolves a live oracle for every
 * reserve. Deposit instruction construction only reads the reserve's lending
 * market, while withdrawal planning reads its on-chain liquidity and
 * collateral exchange state. Neither operation prices the asset. Some valid
 * devnet reserves intentionally have no usable oracle, so the priced loader
 * prevents otherwise valid deposits and exits from being built.
 *
 * The placeholder is explicitly invalid and its price throws if a future SDK
 * version tries to use it. That keeps this seam fail-closed for valuation while
 * allowing the state-only instruction paths we audit below.
 */
async function loadStateOnlyReserves(
  runtime: KaminoRuntime,
  vaultAddress: Address,
  client: Kit2,
  state: Kit2,
  rpc: Kit2,
  klendProgramId: Address,
  slotDurationMs: number
): Promise<Kit2> {
  const reserveAddresses = client.getVaultReserves(state) as Address[];
  let reserveStates: Array<Kit2 | null>;
  try {
    reserveStates = await Reserve.fetchMultiple(
      rpc,
      reserveAddresses as Kit2,
      klendProgramId as Kit2
    );
  } catch (cause) {
    throw vaultUnreadable(vaultAddress, runtime.cluster, cause);
  }

  return new Map(
    reserveAddresses.map((reserveAddress, index) => {
      const reserveState = reserveStates[index];
      if (!reserveState) {
        throw vaultUnreadable(
          vaultAddress,
          runtime.cluster,
          `allocated reserve ${reserveAddress} was not found`
        );
      }
      const unavailableOracle = {
        mintAddress: reserveState.liquidity.mintPubkey,
        decimals: new Decimal(reserveState.liquidity.mintDecimals.toString()),
        get price(): never {
          throw vaultUnreadable(
            vaultAddress,
            runtime.cluster,
            `state-only reserve access attempted to price reserve ${reserveAddress}`
          );
        },
        timestamp: 0n,
        valid: false,
      };
      return [
        reserveAddress,
        new KaminoReserve(
          reserveState,
          reserveAddress as Kit2,
          unavailableOracle as Kit2,
          rpc,
          slotDurationMs
        ),
      ];
    })
  );
}

/** Decimal strings are the boundary currency; `Decimal` never escapes this file. */
function toDecimal(value: string, label: string): Decimal {
  if (!isDecimalString(value)) throw invalidAmount(label, value);
  const parsed = new Decimal(value);
  if (!parsed.isFinite() || parsed.isNegative()) throw invalidAmount(label, value);
  return parsed;
}

/**
 * Validate numeric state observed from klend-sdk without trusting its physical
 * `decimal.js` instance. The SDK carries a nested copy, so normalize through a
 * string and rebuild with this package's pinned Decimal before checking it.
 */
export function requireNonNegativeFiniteDecimal(label: string, value: unknown): Decimal {
  let parsed: Decimal;
  try {
    parsed = new Decimal(String(value));
  } catch (cause) {
    throw new SdpKaminoError(
      "VAULT_UNREADABLE",
      `Kamino ${label} was not a finite non-negative decimal`,
      { cause }
    );
  }
  if (!parsed.isFinite() || parsed.isNegative()) {
    throw new SdpKaminoError(
      "VAULT_UNREADABLE",
      `Kamino ${label} was not a finite non-negative decimal`
    );
  }
  return parsed;
}

/** Re-label kit-2 instructions as this repo's kit-6.8 `Instruction`. Structural. */
function asInstructions(raw: readonly Kit2[]): readonly Instruction[] {
  return (raw ?? []).filter(Boolean) as readonly Instruction[];
}

/** An unsigned integer field off SDK state (`BN`, `Decimal` or number), exactly. */
function bigintField(label: string, value: unknown): bigint {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    throw new SdpKaminoError("VAULT_UNREADABLE", `Kamino ${label} was not an unsigned integer`);
  }
  return BigInt(raw);
}

/** Integer lamports the SDK reports as a `Decimal`, as exact base units. */
function lamportsToBaseUnits(label: string, value: unknown): bigint {
  return BigInt(requireNonNegativeFiniteDecimal(label, value).floor().toFixed(0));
}

/**
 * Fetch the kvault global config under the RIGHT program id.
 *
 * The SDK's own loader repeats the constructor trap: `withdrawIxs` without
 * explicit penalties calls `loadKVaultGlobalConfig`, which derives the config
 * PDA with the client's program id but then fetches it with the DEFAULT
 * (mainnet) id as the expected owner, so a devnet exit throws "belongs to
 * wrong program" before building anything. Measured 2026-08-20 against a
 * devnet fork; deposits never load the config, which is why only the exit
 * path bites. Passing penalties derived from THIS config short-circuits that
 * loader entirely.
 */
async function loadKvaultGlobalConfig(
  runtime: KaminoRuntime,
  vaultAddress: Address,
  config: ReturnType<typeof kaminoClusterConfig>,
  rpc: Kit2
): Promise<Kit2> {
  const globalConfigAddress = await getKvaultGlobalConfigPda(config.kvaultProgramId as Kit2);
  let globalConfig: Kit2;
  try {
    globalConfig = await KVaultGlobalConfig.fetch(
      rpc,
      globalConfigAddress,
      config.kvaultProgramId as Kit2
    );
  } catch (cause) {
    throw vaultUnreadable(vaultAddress, runtime.cluster, cause);
  }
  if (!globalConfig) {
    throw vaultUnreadable(vaultAddress, runtime.cluster, "kvault global config not found");
  }
  return globalConfig;
}

/**
 * Effective withdrawal penalties: max(vault, global config) per field, exactly
 * as the SDK's private `getEffectiveWithdrawalPenaltyParams` computes them.
 * Shared by the exit builder and the exit quote so both price the same fee.
 */
function effectiveWithdrawalPenalties(state: Kit2, globalConfig: Kit2) {
  return {
    withdrawalPenaltyLamports: Decimal.max(
      requireNonNegativeFiniteDecimal(
        "vault withdrawal penalty lamports",
        state.withdrawalPenaltyLamports
      ),
      requireNonNegativeFiniteDecimal(
        "global withdrawal penalty lamports",
        globalConfig.withdrawalPenaltyLamports
      )
    ),
    withdrawalPenaltyBps: Decimal.max(
      requireNonNegativeFiniteDecimal("vault withdrawal penalty bps", state.withdrawalPenaltyBps),
      requireNonNegativeFiniteDecimal(
        "global withdrawal penalty bps",
        globalConfig.withdrawalPenaltyBps
      )
    ),
  };
}

/**
 * Build a deposit.
 *
 * A deposit touches one vault and creates at most the user's share ATA. The
 * complete instruction sequence is compiled as one transaction.
 */
export async function buildKaminoDepositPlan(
  runtime: KaminoRuntime,
  input: KaminoDepositInput,
  assertActive: AssertActive = alwaysActive
): Promise<KaminoInstructionPlan> {
  const { client, vault, state, config, rpc, assetIdentity } = await bindVault(
    runtime,
    input.vault,
    assertActive
  );

  // Precision is checked against the MINT, so it can only be checked once the
  // vault has been read — the token and share mints have independent decimals
  // and neither is knowable at the API boundary.
  const acceptedAmount = acceptAtMintScale(
    "amount",
    input.amount,
    mintDecimals(state.tokenMintDecimals, "tokenMintDecimals")
  );
  if (isZeroAmount(acceptedAmount)) throw invalidAmount("amount", input.amount);
  const amount = toDecimal(acceptedAmount, "amount");

  assertActive();
  // Whether this deposit CREATES the share ATA decides who is owed its rent
  // back, and it cannot be inferred from the instructions: `createAtasIdempotent`
  // emits the same create either way and charges nothing when the account is
  // already there. Only a chain read distinguishes them, so it happens here,
  // concurrently with the reserve load rather than as an extra serial trip.
  const [reserves, shareAccountsResponse, [shareAta]] = await Promise.all([
    loadStateOnlyReserves(
      runtime,
      input.vault,
      client,
      state,
      rpc,
      config.klendProgramId,
      config.slotDurationMs
    ),
    rpc
      .getTokenAccountsByOwner(
        input.owner.address,
        { mint: assetIdentity.shareMint },
        { encoding: "jsonParsed" }
      )
      .send(),
    findAssociatedTokenPda({
      owner: input.owner.address,
      mint: assetIdentity.shareMint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
  ]);
  const createsShareAccount = !parseShareTokenAccountBalances(shareAccountsResponse?.value).some(
    (account) => account.address === shareAta
  );
  assertActive();

  let acceptedMinSharesOut: string | undefined;
  let minSharesOut: Decimal | undefined;
  if (input.minSharesOut !== undefined) {
    acceptedMinSharesOut = acceptAtMintScale(
      "minSharesOut",
      input.minSharesOut,
      mintDecimals(state.sharesMintDecimals, "sharesMintDecimals")
    );
    // A floor that rounds to nothing is worse than no floor: it reads as
    // protection in the request and the ledger while imposing none on chain.
    // The scale check above already refuses sub-atom values, so reaching zero
    // here means the caller literally passed "0".
    if (isZeroAmount(acceptedMinSharesOut)) throw invalidAmount("minSharesOut", input.minSharesOut);
    minSharesOut = toDecimal(acceptedMinSharesOut, "minSharesOut");
  }

  const bundle = await vault.depositIxs(
    input.owner as Kit2,
    amount,
    reserves,
    null,
    null,
    (input.rentPayer ?? input.owner) as Kit2,
    undefined,
    minSharesOut
  );
  assertActive();

  const instructions = asInstructions([
    ...(bundle.depositIxs ?? []),
    ...(bundle.stakeInFarmIfNeededIxs ?? []),
    ...(bundle.stakeInFlcFarmIfNeededIxs ?? []),
  ]);

  return assertPlanTargetsCluster({
    cluster: config.cluster,
    instructions,
    lookupTables: [],
    assetIdentity,
    accepted: {
      amount: acceptedAmount,
      ...(acceptedMinSharesOut === undefined ? {} : { minSharesOut: acceptedMinSharesOut }),
    },
    createsShareAccount,
  });
}

/**
 * Build one complete withdrawal transaction.
 *
 * Kamino may return several withdraw instructions, but they remain one atomic
 * instruction sequence. The vault lookup table travels with the plan so the
 * API can compress the final transaction, including its idempotency memo. The
 * API rejects the final signed bytes if they exceed Solana's packet limit.
 *
 * Every share-redeeming instruction is decoded and the total must exactly match
 * the accepted request. This prevents the ledger from claiming a quantity that
 * differs from what the signed transaction can move.
 *
 * Withdrawal penalties are priced by `quoteKaminoWithdraw`, not here: the
 * kvault withdraw instruction takes only a share amount, so this builder has
 * no floor to encode. NOT covered, deliberately (see CLAUDE.md, known gaps):
 * shares staked in a vault farm are not unstaked. The deposit path never
 * stakes (it passes no farm state), so an SDP-managed position has none;
 * externally staked shares must be unstaked outside SDP before they can exit
 * through it.
 */
export async function buildKaminoWithdrawPlan(
  runtime: KaminoRuntime,
  input: KaminoWithdrawInput,
  assertActive: AssertActive = alwaysActive
): Promise<KaminoInstructionPlan> {
  const { client, vault, state, config, rpc, assetIdentity } = await bindVault(
    runtime,
    input.vault,
    assertActive
  );
  const shareDecimals = mintDecimals(state.sharesMintDecimals, "sharesMintDecimals");
  const acceptedShares = acceptAtMintScale("shares", input.shares, shareDecimals);
  if (isZeroAmount(acceptedShares)) throw invalidAmount("shares", input.shares);
  const requestedBaseUnits = parseDecimalAmount(acceptedShares, shareDecimals);
  const shares = toDecimal(acceptedShares, "shares");

  assertActive();
  // These reads are independent and share one deadline-bounded RPC client.
  // Keeping them concurrent removes several serial round trips from the exit
  // path without weakening any of the validation below.
  const [shareAccountsResponse, reserves, globalConfig, lookupTables] = await Promise.all([
    rpc
      .getTokenAccountsByOwner(
        input.owner.address,
        { mint: assetIdentity.shareMint },
        { encoding: "jsonParsed" }
      )
      .send(),
    loadStateOnlyReserves(
      runtime,
      input.vault,
      client,
      state,
      rpc,
      config.klendProgramId,
      config.slotDurationMs
    ),
    loadKvaultGlobalConfig(runtime, input.vault, config, rpc),
    loadVaultLookupTableAddresses(
      rpc as ReturnType<typeof createKaminoRpc>,
      state.vaultLookupTable === undefined ? undefined : String(state.vaultLookupTable)
    ),
  ]);
  assertActive();
  const shareAccounts = parseShareTokenAccountBalances(shareAccountsResponse?.value);
  const consolidation = await buildShareAccountConsolidation({
    requestedBaseUnits,
    shareMint: assetIdentity.shareMint,
    shareDecimals,
    owner: input.owner,
    rentPayer: input.rentPayer,
    accounts: shareAccounts,
  });

  // Passed explicitly so the SDK never runs its own (mainnet-defaulting)
  // global-config loader; see `loadKvaultGlobalConfig`.
  assertActive();
  const withdrawalPenalties = effectiveWithdrawalPenalties(state, globalConfig);

  // THIRD-PARTY SDK PATCH: klend-sdk plans exits from the share ATA only and
  // exposes no supported shares-state parameter. SDP position reads include
  // every owner token account, so consolidation temporarily replaces this
  // request-scoped client's method with the exact post-transfer ATA state the
  // same transaction will observe. The runtime assertion and construction test
  // intentionally fail an SDK upgrade that removes or renames this method.
  const sdkClient = client as Kit2;
  if (typeof sdkClient.getUserSharesState !== "function") {
    throw vaultUnreadable(
      input.vault,
      runtime.cluster,
      "klend-sdk no longer exposes getUserSharesState required for safe consolidation"
    );
  }
  const originalGetUserSharesState = sdkClient.getUserSharesState.bind(sdkClient);
  if (consolidation.instructions.length > 0) {
    const postConsolidationAta = new Decimal(
      formatDecimalAmount(consolidation.postConsolidationAtaBaseUnits, shareDecimals)
    );
    const totalShares = new Decimal(
      formatDecimalAmount(consolidation.totalBaseUnits, shareDecimals)
    );
    sdkClient.getUserSharesState = async () => ({
      userSharesAta: consolidation.shareAta,
      ataBalance: postConsolidationAta,
      farmBalance: new Decimal(0),
      totalShares,
    });
  }
  let bundle: Awaited<ReturnType<typeof vault.withdrawIxs>>;
  try {
    bundle = await vault.withdrawIxs(
      input.owner as Kit2,
      shares,
      input.slot as Kit2,
      reserves,
      null,
      null,
      (input.rentPayer ?? input.owner) as Kit2,
      withdrawalPenalties as Kit2
    );
  } finally {
    sdkClient.getUserSharesState = originalGetUserSharesState;
  }
  assertActive();

  const kvaultProgramAddress = String(config.kvaultProgramId);
  const decoded: RoleTaggedInstruction[] = [
    ...asInstructions(bundle.unstakeFromFarmIfNeededIxs ?? []).map((instruction) => ({
      instruction,
      role: "unstake" as const,
      sharesBaseUnits: null,
    })),
    // The SDK interleaves prerequisites (ATA creation) into `withdrawIxs`, so
    // membership alone does not mean "redeems shares" — the instruction bytes
    // decide, and only decodable instructions count toward the ledgered total.
    ...asInstructions(bundle.withdrawIxs ?? []).map((instruction): RoleTaggedInstruction => {
      const sharesBaseUnits = decodeKvaultWithdrawShares(instruction, kvaultProgramAddress);
      return {
        instruction,
        role: sharesBaseUnits === null ? "prepare" : "withdraw",
        sharesBaseUnits,
      };
    }),
    ...asInstructions(bundle.postWithdrawIxs ?? []).map((instruction) => ({
      instruction,
      role: "post" as const,
      sharesBaseUnits: null,
    })),
  ]
    // klend-sdk 10.0.0 closes the emptied share ATA itself on a full exit
    // (rides in `postWithdrawIxs`), refunding the OWNER unconditionally. SDP
    // owns that close — the refund destination is attribution-aware (rent a
    // sponsor funded goes back to the sponsor; see
    // `buildShareAccountCloseInstruction` below) — so the SDK's copy is
    // removed and the close appended at the end of this function stays the
    // plan's ONE close. Keeping both fails the exit outright: SPL CloseAccount
    // meets an already-closed account and dies with InvalidAccountData.
    .filter((entry) => !isShareAtaCloseInstruction(entry.instruction, consolidation.shareAta));

  const maximumBalanceGuard = await buildMaximumWithdrawalBalanceGuard({
    requestedBaseUnits,
    shareMint: state.sharesMint as Address,
    shareDecimals,
    owner: input.owner,
  });
  const firstRedemptionIndex = decoded.findIndex((entry) => entry.role === "withdraw");
  const preRedemptionInstructions = [
    ...consolidation.instructions,
    ...(maximumBalanceGuard ? [maximumBalanceGuard] : []),
  ];
  if (preRedemptionInstructions.length > 0 && firstRedemptionIndex === -1) {
    throw new SdpKaminoError(
      "VAULT_UNREADABLE",
      "Kamino produced no redemption instruction after preparing the withdrawal share balance."
    );
  }
  const guarded =
    preRedemptionInstructions.length > 0
      ? [
          ...decoded.slice(0, firstRedemptionIndex),
          ...preRedemptionInstructions.map((instruction) => ({
            instruction,
            role: "prepare" as const,
            sharesBaseUnits: null,
          })),
          ...decoded.slice(firstRedemptionIndex),
        ]
      : decoded;

  // A full exit uses a burn-all sentinel on its final redemption instruction.
  // Replace it with the exact remainder, except at maximum-u64 where the atomic
  // balance guard above makes the sentinel exact or fails the transaction.
  const tagged = resolveBurnAllSentinel({
    instructions: guarded,
    requestedBaseUnits,
    maximumBalanceGuarded: maximumBalanceGuard !== null,
  });
  const encodedBaseUnits = tagged.reduce((sum, entry) => sum + (entry.sharesBaseUnits ?? 0n), 0n);
  if (encodedBaseUnits !== requestedBaseUnits) {
    // Includes the zero-withdraw-instruction case. Whatever the SDK did — a
    // capped amount, a sentinel encoding, a new instruction variant this decode
    // does not know — signing it would ledger a quantity the chain will not
    // move, so the only safe answer is a loud refusal.
    throw new SdpKaminoError(
      "VAULT_UNREADABLE",
      `Kamino withdraw instructions encode ${encodedBaseUnits} share base units where the ` +
        `accepted request is ${requestedBaseUnits}; refusing to build a plan whose ledger ` +
        "record would not match what moves on chain."
    );
  }

  // Give the share ATA's rent back, but ONLY when this exit provably empties it.
  //
  // SPL `CloseAccount` fails on a non-zero balance, and a failed close fails the
  // whole withdrawal, so this condition has to be exact rather than optimistic.
  // It is: the redemptions above are asserted to encode exactly
  // `requestedBaseUnits`, and consolidation reports what the ATA will hold when
  // they run, so equality means the account ends at zero. A partial exit
  // correctly leaves the account open, still holding shares and still holding
  // its rent.
  //
  // Appended AFTER the share-encoding assertion on purpose. A close redeems no
  // shares, and folding it in earlier would invite a future edit to count it.
  // It is last in the instruction order because it must follow every redemption.
  // Did THIS exit create the share account? If so it also paid the rent, and
  // that beats whatever the caller recorded from an earlier movement: a single
  // transaction can create the account, consolidate into it, redeem everything
  // and close it, and in that case the party owed the refund is the one who
  // funded it moments earlier in the same transaction. Only when the account
  // pre-dates this exit does the recorded funder describe who paid for it.
  const createsShareAccount = !shareAccounts.some(
    (account) => account.address === consolidation.shareAta
  );
  const rentRefundTo = createsShareAccount ? input.rentPayer?.address : input.rentRefundTo;
  const closeShareAccountInstruction = buildShareAccountCloseInstruction({
    shareAta: consolidation.shareAta,
    owner: input.owner,
    ...(rentRefundTo === undefined ? {} : { refundTo: rentRefundTo }),
    ataBaseUnitsBeforeExit: consolidation.postConsolidationAtaBaseUnits,
    redeemedBaseUnits: requestedBaseUnits,
    ownerTotalBaseUnits: consolidation.totalBaseUnits,
  });

  return assertPlanTargetsCluster({
    cluster: config.cluster,
    instructions: [
      ...tagged.map((entry) => entry.instruction),
      ...(closeShareAccountInstruction ? [closeShareAccountInstruction] : []),
    ],
    lookupTables: Object.keys(lookupTables) as Address[],
    assetIdentity,
    accepted: { shares: acceptedShares },
    // An EXIT can create the share ATA too, and charge its rent to `rentPayer`:
    // consolidation emits an idempotent create, and klend interleaves its own
    // ATA prerequisites into the withdraw bundle. So the same observation the
    // deposit path makes has to be reported here, or an exit that paid the rent
    // would leave the position naming whoever funded a PREVIOUS instance of the
    // account, and the next close would refund the wrong party.
    createsShareAccount,
  });
}

/**
 * Discover every K-Vault in which an owner may hold shares.
 *
 * This deliberately uses the on-chain kvault program census rather than the
 * curated strategy catalogue. Catalogue admission filters (known mint,
 * metrics, TVL) decide what SDP offers for NEW deposits; they must never hide
 * money the owner already holds in a filtered or delisted vault.
 *
 * klend-sdk's bulk helper is safe only as a CANDIDATE INDEX. Its unstaked
 * balances pass through JSON `uiAmount` and it overwrites rather than sums
 * multiple token accounts. We therefore consume only the returned vault keys;
 * `readKaminoPosition` re-reads every candidate in exact base units below and
 * is the sole source of balances returned to callers.
 */
export async function discoverKaminoPositionVaults(
  runtime: KaminoRuntime,
  owner: Address,
  assertActive: AssertActive = alwaysActive
): Promise<Address[]> {
  assertActive();
  const { client } = createVaultClient(runtime);
  let candidateBalances: Map<Kit2, Kit2>;
  try {
    candidateBalances = await client.getUserSharesBalanceAllVaults(owner as Kit2);
  } catch (cause) {
    throw new SdpKaminoError(
      "VAULT_UNREADABLE",
      `Kamino holdings could not be discovered on ${runtime.cluster}; refusing to report an empty portfolio.`,
      { cause }
    );
  }
  assertActive();
  return [...candidateBalances.keys()].map((vault) => vault as Address);
}

/**
 * Sum an owner's share-token accounts in EXACT base units.
 *
 * Deliberately reads `tokenAmount.amount` — the raw integer string — and never
 * `uiAmount`, which the RPC serialises as a JSON number and which therefore
 * cannot represent a balance above 2^53 base units without rounding. Returns
 * `bigint` so nothing between here and the mint's decimals can go lossy.
 *
 * Sums ALL matching accounts rather than just the ATA, matching what the SDK
 * counts: a wallet may legitimately hold the same share mint in more than one
 * token account, and ignoring the others would under-report someone's position.
 */
async function readUnstakedShareBaseUnits(
  rpc: Kit2,
  owner: Address,
  sharesMint: Address
): Promise<bigint> {
  const response = await rpc
    .getTokenAccountsByOwner(owner, { mint: sharesMint }, { encoding: "jsonParsed" })
    .send();

  // The RPC filter says every entry is part of this balance. A malformed entry
  // therefore makes the whole position unreadable; summing only the readable
  // subset would silently under-report funds.
  return sumRawTokenAccountBaseUnits(response?.value);
}

/**
 * One wallet's holding in one vault, read live.
 *
 * `tokenValue` is shares × exchange rate. The rate read is allowed to fail
 * independently of the share read: a position whose size is known but whose
 * value is not renders "—" for the value, which is the module rule everywhere
 * else in Earn and strictly better than a fabricated number.
 */
export async function readKaminoPosition(
  runtime: KaminoRuntime,
  input: { vault: Address; owner: Address; slot: bigint },
  assertActive: AssertActive = alwaysActive
): Promise<KaminoPosition> {
  const { client, vault, state, config, rpc, assetIdentity } = await bindVault(
    runtime,
    input.vault,
    assertActive
  );
  const shareDecimals = mintDecimals(state.sharesMintDecimals, "sharesMintDecimals");

  // UNSTAKED shares are counted here rather than taken from the SDK, and that is
  // the whole point of this block. `vault.getUserShares` sums its token accounts
  // through `getTokenAccountAmount`, which returns
  // `parsed.info.tokenAmount.uiAmount` — a JavaScript NUMBER. Above 2^53 base
  // units that has already lost value, and no amount of `Decimal`-wrapping
  // downstream can put it back. `amount` on the same parsed account is the exact
  // base-unit string, so this reads that and scales it by the share mint itself.
  //
  // STAKED shares still come from the SDK: that half is derived from farm state
  // as an exact `Decimal`, never through `uiAmount`, so re-implementing it would
  // duplicate the farm lookup for no precision gain.
  assertActive();
  const staked = await vault.getUserShares(input.owner as Kit2);
  assertActive();
  const unstakedBase = await readUnstakedShareBaseUnits(rpc, input.owner, assetIdentity.shareMint);
  assertActive();
  const shares = requireNonNegativeFiniteDecimal(
    "total share balance",
    new Decimal(formatDecimalAmount(unstakedBase, shareDecimals)).add(
      requireNonNegativeFiniteDecimal("staked share balance", staked.stakedShares)
    )
  );

  let tokenValue: string | undefined;
  let rawRate: unknown;
  try {
    const reserves = await loadStateOnlyReserves(
      runtime,
      input.vault,
      client,
      state,
      rpc,
      config.klendProgramId,
      config.slotDurationMs
    );
    rawRate = await client.getTokensPerShareSingleVault(
      state,
      input.slot as Kit2,
      reserves,
      input.slot as Kit2
    );
  } catch {
    rawRate = undefined;
  }
  assertActive();
  try {
    if (rawRate === undefined) throw new Error("vault exchange rate unavailable");
    const rate = requireNonNegativeFiniteDecimal("vault exchange rate", rawRate);
    const decimals = mintDecimals(state.tokenMintDecimals, "tokenMintDecimals");
    // Round-trip through the repo's own fixed-point helpers so the string that
    // leaves this package is scaled exactly like every other amount in SDP.
    const raw = requireNonNegativeFiniteDecimal("vault token value", shares.mul(rate)).toFixed(
      decimals,
      Decimal.ROUND_DOWN
    );
    tokenValue = formatDecimalAmount(parseDecimalAmount(raw, decimals), decimals);
  } catch {
    tokenValue = undefined;
  }

  return {
    vault: input.vault,
    owner: input.owner,
    cluster: config.cluster,
    shares: shares.toFixed(),
    withdrawableShares: formatDecimalAmount(unstakedBase, shareDecimals),
    ...(tokenValue === undefined ? {} : { tokenValue }),
    tokenMint: assetIdentity.depositTokenMint,
    sharesMint: assetIdentity.shareMint,
  };
}

/** klend-sdk's `DEFAULT_PUBLIC_KEY`: an allocation slot with no reserve. */
const EMPTY_ALLOCATION_RESERVE = "11111111111111111111111111111111";

/**
 * The pricing inputs `estimateSharesFromTokens` uses, replicated so the cap
 * clamp it applies silently can be detected (`detectDepositCapClamp`). Mirrors
 * the SDK's own arithmetic: crank funds are charged per allocation with a live
 * reserve, positive weight and positive cap; the net AUM is the holdings less
 * pending fees plus rewards vested up to now, rounded up to base units.
 */
function observeDepositPricing(
  client: Kit2,
  state: Kit2,
  slot: Kit2,
  reserves: Kit2,
  tokenDecimals: number,
  amountBaseUnits: bigint
) {
  const allocations = (state.vaultAllocationStrategy ?? []) as Kit2[];
  const chargedReserves = allocations.filter(
    (allocation) =>
      String(allocation.reserve) !== EMPTY_ALLOCATION_RESERVE &&
      bigintField("allocation weight", allocation.targetAllocationWeight) > 0n &&
      bigintField("allocation cap", allocation.tokenAllocationCap) > 0n
  ).length;
  const crankFunds =
    bigintField("crank fund fee", state.crankFundFeePerReserve) * BigInt(chargedReserves);
  const sharesIssued = bigintField("shares issued", state.sharesIssued);

  let netAum = 0n;
  if (sharesIssued > 0n) {
    const holdings = client.computeVaultHoldings(state, slot, reserves, slot);
    const netAumTokens = requireNonNegativeFiniteDecimal(
      "vault net AUM",
      holdings.totalAUMIncludingFees.sub(holdings.pendingFees)
    );
    const perSecond = bigintField("reward per second", state.rewardInfo.rewardPerSecond);
    const rewardsAvailable = bigintField("rewards available", state.rewardInfo.rewardsAvailable);
    const issuedAt = bigintField("reward issuance timestamp", state.rewardInfo.lastIssuanceTs);
    let vested = 0n;
    if (perSecond > 0n && rewardsAvailable > 0n && issuedAt !== 0n) {
      const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
      const elapsed = nowSeconds > issuedAt ? nowSeconds - issuedAt : 0n;
      const accrued = elapsed * perSecond;
      vested = accrued < rewardsAvailable ? accrued : rewardsAvailable;
    }
    netAum =
      BigInt(netAumTokens.mul(new Decimal(10).pow(tokenDecimals)).ceil().toFixed(0)) + vested;
  }

  return {
    tokensForSharesBaseUnits: amountBaseUnits - crankFunds,
    depositCapBaseUnits: bigintField("deposit cap", state.depositCap),
    netAumBaseUnits: netAum,
    sharesIssuedBaseUnits: sharesIssued,
  };
}

/**
 * Quote a deposit: the shares the vault would mint for `amount` right now.
 *
 * A READ. No instruction is built and nothing is signed; the estimate is a
 * pure function of the state loaded here, and the SDK's own doc calls it an
 * estimate (accrual between quote and execution lowers the shares out), so a
 * floor derived from it should carry a discount. Blocking conditions come
 * back as `issues` rather than as thrown errors.
 */
export async function quoteKaminoDeposit(
  runtime: KaminoRuntime,
  input: KaminoDepositQuoteInput,
  assertActive: AssertActive = alwaysActive
): Promise<KaminoDepositQuote> {
  const { client, state, config, rpc } = await bindVault(runtime, input.vault, assertActive);
  const tokenDecimals = mintDecimals(state.tokenMintDecimals, "tokenMintDecimals");
  const shareDecimals = mintDecimals(state.sharesMintDecimals, "sharesMintDecimals");
  const acceptedAmount = acceptAtMintScale("amount", input.amount, tokenDecimals);
  if (isZeroAmount(acceptedAmount)) throw invalidAmount("amount", input.amount);
  const amount = toDecimal(acceptedAmount, "amount");

  assertActive();
  const reserves = await loadStateOnlyReserves(
    runtime,
    input.vault,
    client,
    state,
    rpc,
    config.klendProgramId,
    config.slotDurationMs
  );
  assertActive();

  let sharesOutBaseUnits: bigint;
  let pricing: ReturnType<typeof observeDepositPricing>;
  try {
    const estimate = requireNonNegativeFiniteDecimal(
      "estimated shares",
      client.estimateSharesFromTokens(state, amount, input.slot as Kit2, reserves)
    );
    // Same fixed-point round trip as the position read: what leaves this
    // package is scaled exactly like every other amount in SDP.
    sharesOutBaseUnits = parseDecimalAmount(
      estimate.toFixed(shareDecimals, Decimal.ROUND_DOWN),
      shareDecimals
    );
    pricing = observeDepositPricing(
      client,
      state,
      input.slot as Kit2,
      reserves,
      tokenDecimals,
      parseDecimalAmount(acceptedAmount, tokenDecimals)
    );
  } catch (cause) {
    if (cause instanceof SdpKaminoError) throw cause;
    throw vaultUnreadable(input.vault, runtime.cluster, cause);
  }

  return deriveKaminoDepositQuote({ sharesOutBaseUnits, shareDecimals, ...pricing });
}

/**
 * Quote an exit: the tokens `shares` would return right now, net of the
 * effective withdrawal penalties and lowered for a split exit (see
 * `conservativeExitNetBaseUnits`). A READ, same posture as the deposit quote.
 */
export async function quoteKaminoWithdraw(
  runtime: KaminoRuntime,
  input: KaminoWithdrawQuoteInput,
  assertActive: AssertActive = alwaysActive
): Promise<KaminoWithdrawQuote> {
  const { client, state, config, rpc } = await bindVault(runtime, input.vault, assertActive);
  const shareDecimals = mintDecimals(state.sharesMintDecimals, "sharesMintDecimals");
  const assetDecimals = mintDecimals(state.tokenMintDecimals, "tokenMintDecimals");
  const acceptedShares = acceptAtMintScale("shares", input.shares, shareDecimals);
  if (isZeroAmount(acceptedShares)) throw invalidAmount("shares", input.shares);
  const shares = toDecimal(acceptedShares, "shares");

  assertActive();
  const [reserves, globalConfig] = await Promise.all([
    loadStateOnlyReserves(
      runtime,
      input.vault,
      client,
      state,
      rpc,
      config.klendProgramId,
      config.slotDurationMs
    ),
    loadKvaultGlobalConfig(runtime, input.vault, config, rpc),
  ]);
  assertActive();
  const withdrawalPenalties = effectiveWithdrawalPenalties(state, globalConfig);

  let plan: Kit2;
  try {
    const tokensPerShare = await client.getTokensPerShareSingleVault(
      state,
      input.slot as Kit2,
      reserves,
      input.slot as Kit2
    );
    // The Earn quote input names no owner, so the requested quantity is priced
    // on its own: the SDK clamps an exit to `totalUserShareTokens`, and passing
    // the request there plans exactly the requested shares. Whether the wallet
    // holds them is the builder's check (`buildShareAccountConsolidation`).
    plan = await client.getShareExitLiquidityPlan(
      state,
      input.slot as Kit2,
      reserves,
      shares,
      shares,
      tokensPerShare,
      withdrawalPenalties as Kit2
    );
  } catch (cause) {
    throw vaultUnreadable(input.vault, runtime.cluster, cause);
  }
  assertActive();

  // One entry per withdraw instruction the exit will emit, in plan order: the
  // idle-liquidity leg when the plan draws on it, then each reserve leg.
  const availableLeg = lamportsToBaseUnits(
    "idle-liquidity exit leg",
    plan.availableTokenLamportsToWithdraw
  );
  const legNetBaseUnits = [
    ...(availableLeg > 0n ? [availableLeg] : []),
    ...[...(plan.reserveTokenLamportsToWithdraw as Map<unknown, Kit2>).values()].map((leg) =>
      lamportsToBaseUnits("reserve exit leg", leg)
    ),
  ];
  return deriveKaminoWithdrawQuote({
    netBaseUnits: lamportsToBaseUnits("net exit amount", plan.netTokenLamportsToWithdraw),
    flatPenaltyBaseUnits: lamportsToBaseUnits(
      "flat withdrawal penalty",
      withdrawalPenalties.withdrawalPenaltyLamports
    ),
    legNetBaseUnits,
    remainingBaseUnits: lamportsToBaseUnits(
      "unfilled exit amount",
      plan.remainingNetTokenLamportsToWithdraw
    ),
    minimumWithdrawalBaseUnits: bigintField("minimum withdrawal", state.minWithdrawAmount),
    assetDecimals,
  });
}
