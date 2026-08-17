import { KaminoVault, KaminoVaultClient } from "@kamino-finance/klend-sdk";
import { formatDecimalAmount, isDecimalString, parseDecimalAmount } from "@sdp/solana/amount";
import type { Address, Instruction } from "@solana/kit";
import Decimal from "decimal.js";
import { acceptAtMintScale, isZeroAmount, mintDecimals } from "./amounts";
import { vaultAssetIdentityFromState } from "./asset-identity";
import { invalidAmount, SdpKaminoError, vaultUnreadable } from "./errors";
import { assertPlanTargetsCluster } from "./guards";
import { kaminoClusterConfig } from "./programs";
import { createKaminoRpc } from "./rpc";
import { sumRawTokenAccountBaseUnits } from "./share-balances";
import type {
  KaminoDepositInput,
  KaminoInstructionPlan,
  KaminoPosition,
  KaminoRuntime,
  KaminoWithdrawInput,
} from "./types";

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

async function bindVault(runtime: KaminoRuntime, vaultAddress: Address) {
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

/**
 * Build a deposit.
 *
 * Returned as a single batch: a deposit touches one vault and creates at most
 * the user's share ATA, which has always fit one transaction in measurement.
 * Withdrawals are the multi-batch case (see below).
 */
export async function buildKaminoDepositPlan(
  runtime: KaminoRuntime,
  input: KaminoDepositInput
): Promise<KaminoInstructionPlan> {
  const { client, vault, state, config, assetIdentity } = await bindVault(runtime, input.vault);

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

  const reserves = await client.loadVaultReserves(state);

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

  const instructions = asInstructions([
    ...(bundle.depositIxs ?? []),
    ...(bundle.stakeInFarmIfNeededIxs ?? []),
    ...(bundle.stakeInFlcFarmIfNeededIxs ?? []),
  ]);

  return assertPlanTargetsCluster({
    cluster: config.cluster,
    instructions: [instructions],
    lookupTables: [],
    assetIdentity,
    accepted: {
      amount: acceptedAmount,
      ...(acceptedMinSharesOut === undefined ? {} : { minSharesOut: acceptedMinSharesOut }),
    },
  });
}

/**
 * Build a withdrawal. **NOT CONTRACT-COMPLETE — see the warning below.**
 *
 * ── Why this is not exported as a capability ────────────────────────────────
 * `KaminoInstructionPlan.instructions` promises TRANSACTION-SIZED batches: one
 * entry, one transaction. This function cannot honour that promise yet. It
 * flattens `unstake → withdraw → post` into a single batch and returns no
 * lookup table, while the pinned SDK documents the opposite — `withdrawIxs`
 * returns "one or multiple withdraw instructions, based on how many reserves
 * it's needed to withdraw from. This might have to be split in multiple
 * transactions". A multi-reserve exit therefore builds a plan that can exceed
 * Solana's 1232-byte packet, and the API's submitter refuses any plan with more
 * than one transaction — so the failure lands at submit, after the caller has
 * been told a withdrawal was prepared.
 *
 * Honouring the contract needs three things this does not do: load the vault's
 * published lookup table, compile-measure and split at valid protocol
 * boundaries (an unstake must never land without its withdraw), and give the
 * API a resumable multi-leg submission with per-leg ledger rows.
 *
 * Until then the WITHDRAW CAPABILITY IS WITHHELD: `KaminoVaultDirectClient` does
 * not implement `buildVaultWithdrawal`, so `supportsVaultWithdraw` answers false
 * and no route can move money out through an unsized plan. This builder stays in
 * the package because it is proven against a mainnet-forked surfnet and is the
 * starting point for that work — it is deliberately NOT re-exported from
 * `index.ts`, so the only callers are this package's own smoke tests.
 *
 * Tracked as the exit half of the vault-direct path; see `CLAUDE.md`.
 */
export async function buildKaminoWithdrawPlan(
  runtime: KaminoRuntime,
  input: KaminoWithdrawInput
): Promise<KaminoInstructionPlan> {
  const { client, vault, state, config, assetIdentity } = await bindVault(runtime, input.vault);
  const acceptedShares = acceptAtMintScale(
    "shares",
    input.shares,
    mintDecimals(state.sharesMintDecimals, "sharesMintDecimals")
  );
  if (isZeroAmount(acceptedShares)) throw invalidAmount("shares", input.shares);
  const shares = toDecimal(acceptedShares, "shares");

  const reserves = await client.loadVaultReserves(state);
  const bundle = await vault.withdrawIxs(
    input.owner as Kit2,
    shares,
    input.slot as Kit2,
    reserves,
    null,
    null,
    (input.rentPayer ?? input.owner) as Kit2
  );

  const instructions = asInstructions([
    ...(bundle.unstakeFromFarmIfNeededIxs ?? []),
    ...(bundle.withdrawIxs ?? []),
    ...(bundle.postWithdrawIxs ?? []),
  ]);

  return assertPlanTargetsCluster({
    cluster: config.cluster,
    instructions: [instructions],
    lookupTables: [],
    assetIdentity,
    accepted: { shares: acceptedShares },
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
  owner: Address
): Promise<Address[]> {
  const { client } = createVaultClient(runtime);
  try {
    const candidateBalances = await client.getUserSharesBalanceAllVaults(owner as Kit2);
    return [...candidateBalances.keys()].map((vault) => vault as Address);
  } catch (cause) {
    throw new SdpKaminoError(
      "VAULT_UNREADABLE",
      `Kamino holdings could not be discovered on ${runtime.cluster}; refusing to report an empty portfolio.`,
      { cause }
    );
  }
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
  input: { vault: Address; owner: Address; slot: bigint }
): Promise<KaminoPosition> {
  const { vault, state, config, rpc, assetIdentity } = await bindVault(runtime, input.vault);
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
  const staked = await vault.getUserShares(input.owner as Kit2);
  const unstakedBase = await readUnstakedShareBaseUnits(rpc, input.owner, assetIdentity.shareMint);
  const shares = requireNonNegativeFiniteDecimal(
    "total share balance",
    new Decimal(formatDecimalAmount(unstakedBase, shareDecimals)).add(
      requireNonNegativeFiniteDecimal("staked share balance", staked.stakedShares)
    )
  );

  let tokenValue: string | undefined;
  try {
    const rate = requireNonNegativeFiniteDecimal(
      "vault exchange rate",
      await vault.getExchangeRate(input.slot as Kit2)
    );
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
    ...(tokenValue === undefined ? {} : { tokenValue }),
    tokenMint: assetIdentity.depositTokenMint,
    sharesMint: assetIdentity.shareMint,
  };
}
