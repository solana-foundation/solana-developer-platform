import { KaminoVault, KaminoVaultClient } from "@kamino-finance/klend-sdk";
import { formatDecimalAmount, isDecimalString, parseDecimalAmount } from "@sdp/solana/amount";
import { type Address, address, createSolanaRpc, type Instruction } from "@solana/kit";
import Decimal from "decimal.js";
import { invalidAmount, vaultUnreadable } from "./errors";
import { assertPlanTargetsCluster } from "./guards";
import { kaminoClusterConfig } from "./programs";
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
async function bindVault(runtime: KaminoRuntime, vaultAddress: Address) {
  const config = kaminoClusterConfig(runtime.cluster);
  const rpc = createSolanaRpc(runtime.rpcUrl) as Kit2;

  const client = new KaminoVaultClient(
    rpc,
    config.slotDurationMs,
    config.kvaultProgramId as Kit2,
    config.klendProgramId as Kit2,
    undefined,
    config.farmsProgramId as Kit2
  );

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
  return { client, vault, state, config, rpc };
}

/** Decimal strings are the boundary currency; `Decimal` never escapes this file. */
function toDecimal(value: string, label: string): Decimal {
  if (!isDecimalString(value)) throw invalidAmount(label, value);
  const parsed = new Decimal(value);
  if (!parsed.isFinite() || parsed.isNegative()) throw invalidAmount(label, value);
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
  const { client, vault, state, config } = await bindVault(runtime, input.vault);
  const amount = toDecimal(input.amount, "amount");
  if (amount.isZero()) throw invalidAmount("amount", input.amount);

  const reserves = await client.loadVaultReserves(state);
  const minSharesOut =
    input.minSharesOut === undefined ? undefined : toDecimal(input.minSharesOut, "minSharesOut");

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
  });
}

/**
 * Build a withdrawal.
 *
 * `unstake → withdraw → post` are returned as ONE batch because they must land
 * atomically: unstaking without the withdraw leaves the position in a state the
 * user did not ask for. If a future vault's reserve set makes that exceed the
 * 1232-byte packet, the fix is a lookup table (Kamino publishes one per vault),
 * NOT splitting these apart — which is why the plan carries `lookupTables` and
 * why the caller is handed batches rather than a flat list.
 */
export async function buildKaminoWithdrawPlan(
  runtime: KaminoRuntime,
  input: KaminoWithdrawInput
): Promise<KaminoInstructionPlan> {
  const { client, vault, state, config } = await bindVault(runtime, input.vault);
  const shares = toDecimal(input.shares, "shares");
  if (shares.isZero()) throw invalidAmount("shares", input.shares);

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
  });
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
  const { vault, state, config } = await bindVault(runtime, input.vault);

  const userShares = await vault.getUserShares(input.owner as Kit2);
  const shares = new Decimal(String(userShares.totalShares ?? 0));

  let tokenValue: string | undefined;
  try {
    const rate: Decimal = await vault.getExchangeRate(input.slot as Kit2);
    const decimals = Number(state.tokenMintDecimals ?? 6);
    // Round-trip through the repo's own fixed-point helpers so the string that
    // leaves this package is scaled exactly like every other amount in SDP.
    const raw = shares.mul(rate).toFixed(decimals, Decimal.ROUND_DOWN);
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
    tokenMint: address(String(state.tokenMint)),
    sharesMint: address(String(state.sharesMint)),
  };
}
