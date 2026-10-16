import {
  getKvaultGlobalConfigPda,
  KaminoReserve,
  KaminoVault,
  KaminoVaultClient,
  KVaultGlobalConfig,
  Reserve,
} from "@kamino-finance/klend-sdk";
import {
  getFarmUserStatePDA,
  getUserSharesInTokensStakedInFarm,
} from "@kamino-finance/klend-sdk/dist/classes/farm_utils.js";
import { formatDecimalAmount, isDecimalString, parseDecimalAmount } from "@sdp/solana/amount";
import { type Address, address, getBase64Encoder, type Instruction } from "@solana/kit";
import {
  AccountState,
  findAssociatedTokenPda,
  getTokenDecoder,
  getTokenSize,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import Decimal from "decimal.js";
import { acceptAtMintScale, isZeroAmount, mintDecimals } from "./amounts";
import { vaultAssetIdentityFromState } from "./asset-identity";
import { KAMINO_POSITION_READ_CONCURRENCY, mapSettledWithConcurrency } from "./concurrency";
import { depositFloorUnsupported, invalidAmount, SdpKaminoError, vaultUnreadable } from "./errors";
import { assertPlanTargetsCluster } from "./guards";
import { configuredLookupTable, loadVaultLookupTableAddresses } from "./lookup-table";
import { kaminoClusterConfig } from "./programs";
import {
  deriveKaminoDepositQuote,
  deriveKaminoWithdrawQuote,
  type KaminoDepositQuote,
  type KaminoDepositQuoteInput,
  type KaminoWithdrawQuote,
  type KaminoWithdrawQuoteInput,
} from "./quotes";
import { createKaminoReadRpc, createKaminoRpc } from "./rpc";
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
/** This repo's kit RPC, as `createKaminoRpc` and `createKaminoReadRpc` build it. */
type KaminoRpc = ReturnType<typeof createKaminoRpc>;
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
function createVaultClient(
  runtime: KaminoRuntime,
  // The transport deadline covers both our direct reads and every nested
  // reserve/farm/vault request klend-sdk performs with this same client.
  rpc: Kit2 = createKaminoRpc(runtime.rpcUrl)
) {
  const config = kaminoClusterConfig(runtime.cluster);

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
  assertActive: AssertActive = alwaysActive,
  reads: { rpc?: KaminoRpc; accounts?: BatchRpc } = {}
) {
  assertActive();
  const { client, config, rpc } = createVaultClient(runtime, reads.rpc);

  // The probe exists only to fetch state under the right program id; it is never
  // used to build anything.
  const probe = new KaminoVault(
    reads.accounts ?? rpc,
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
  slotDurationMs: number,
  accounts: BatchRpc
): Promise<Kit2> {
  const reserveAddresses = client.getVaultReserves(state) as Address[];
  let reserveStates: Array<Kit2 | null>;
  try {
    reserveStates = await Reserve.fetchMultiple(
      accounts as Kit2,
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

/** Solana's `getMultipleAccounts` limit per request. */
const MAX_ACCOUNTS_PER_REQUEST = 100;

/** The one request a batch sends. */
interface AccountsReader {
  getMultipleAccounts(
    addresses: readonly Address[],
    config: { encoding: "base64" | "jsonParsed" }
  ): { send(): Promise<unknown> };
}

interface BatchRequest<T> {
  send(): Promise<{ context: { slot: bigint }; value: T }>;
}

/** The account reads klend-sdk's fetchers and kit's table loader send. */
interface BatchRpc {
  getAccountInfo(key: unknown, config?: { encoding?: unknown }): BatchRequest<object | null>;
  getMultipleAccounts(
    keys: readonly unknown[],
    config?: { encoding?: unknown }
  ): BatchRequest<Array<object | null>>;
}

/**
 * Accounts read in one `getMultipleAccounts` per 100 addresses, served back as
 * a read-only RPC so klend-sdk and kit decode exactly the bytes they would
 * otherwise fetch one by one. A failed read rejects every account it carried;
 * an address outside the batch, or base64 asked of a parsed account, fails
 * closed.
 */
interface AccountBatch {
  rpc: BatchRpc;
  account(address: string): object | null;
}

function accountBatch(read: ReadonlyMap<string, object | null> | Error, slot = 0n): AccountBatch {
  const account = (key: unknown): object | null => {
    if (read instanceof Error) throw read;
    const value = read.get(String(key));
    if (value === undefined)
      throw new Error(`Kamino read ${String(key)} outside its account batch`);
    return value;
  };
  const served = (key: unknown, config: { encoding?: unknown } | undefined): object | null => {
    const value = account(key);
    if (value !== null && config?.encoding !== "jsonParsed" && base64Data(value) === undefined) {
      throw new Error(`Kamino batched account ${String(key)} was not returned as base64`);
    }
    return value;
  };
  return {
    account,
    rpc: {
      getAccountInfo: (key, config) => ({
        send: async () => ({ context: { slot }, value: served(key, config) }),
      }),
      getMultipleAccounts: (keys, config) => ({
        send: async () => ({ context: { slot }, value: keys.map((key) => served(key, config)) }),
      }),
    },
  };
}

function failedBatch(cause: unknown): AccountBatch {
  return accountBatch(cause instanceof Error ? cause : new Error(String(cause)));
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

/** The payload of an account returned as base64, else undefined. */
function base64Data(value: object): string | undefined {
  const data: unknown = "data" in value ? value.data : undefined;
  if (!Array.isArray(data)) return undefined;
  const [payload, encoding]: unknown[] = data;
  return encoding === "base64" && typeof payload === "string" ? payload : undefined;
}

function contextSlot(response: unknown): bigint {
  const context = isObject(response) && "context" in response ? response.context : undefined;
  const slot = isObject(context) && "slot" in context ? context.slot : undefined;
  if (typeof slot !== "bigint" && typeof slot !== "number") {
    throw new Error("Kamino getMultipleAccounts answered without a context slot");
  }
  return BigInt(slot);
}

/** Sorted and de-duplicated, so identical reads from concurrent owners are one request. */
async function readAccountBatch(
  rpc: AccountsReader,
  addresses: readonly string[],
  encoding: "base64" | "jsonParsed" = "base64"
): Promise<AccountBatch> {
  const unique = [...new Set(addresses)].sort();
  const chunks: string[][] = [];
  for (let start = 0; start < unique.length; start += MAX_ACCOUNTS_PER_REQUEST) {
    chunks.push(unique.slice(start, start + MAX_ACCOUNTS_PER_REQUEST));
  }
  const responses = await Promise.all(
    chunks.map((chunk) => rpc.getMultipleAccounts(chunk as Address[], { encoding }).send())
  );
  const read = new Map<string, object | null>();
  let slot: bigint | undefined;
  chunks.forEach((chunk, index) => {
    const response: unknown = responses[index];
    const values = isObject(response) && "value" in response ? response.value : undefined;
    if (!Array.isArray(values) || values.length !== chunk.length) {
      throw new Error("Kamino getMultipleAccounts answered a different number of accounts");
    }
    chunk.forEach((key, position) => {
      const value: unknown = values[position];
      if (value !== null && !isObject(value)) {
        throw new Error(`Kamino getMultipleAccounts returned no account record for ${key}`);
      }
      read.set(key, value);
    });
    const observed = contextSlot(response);
    slot = slot === undefined || observed < slot ? observed : slot;
  });
  return accountBatch(read, slot);
}

/** The allocated reserves `loadStateOnlyReserves` reads for this state. */
function vaultReserves(
  client: KaminoVaultClient,
  state: Parameters<KaminoVaultClient["getVaultReserves"]>[0]
): string[] {
  return client.getVaultReserves(state).map(String);
}

async function kvaultGlobalConfigAddress(
  config: ReturnType<typeof kaminoClusterConfig>
): Promise<Address> {
  return String(await getKvaultGlobalConfigPda(config.kvaultProgramId as Kit2)) as Address;
}

/** klend-sdk's `DEFAULT_PUBLIC_KEY`: an unset allocation slot or farm. */
const DEFAULT_PUBLIC_KEY = "11111111111111111111111111111111";

/** The farms `getUserSharesBalanceSingleVault` reads staked shares from, in its order. */
function configuredFarms(state: { vaultFarm: unknown; firstLossCapitalFarm: unknown }): string[] {
  return [state.vaultFarm, state.firstLossCapitalFarm]
    .filter((farm) => farm !== DEFAULT_PUBLIC_KEY)
    .map(String);
}

/**
 * Whether `value` is an account `getTokenAccountsByOwner(owner, { mint })`
 * lists: a 165-byte, initialized Token-program account of `mint` owned by
 * `owner`.
 */
function listsAsShareAccount(value: object | null, owner: Address, mint: Address): boolean {
  if (value === null) return false;
  const data = base64Data(value);
  if (data === undefined) {
    throw new Error("Kamino share account was not returned as base64");
  }
  const program: unknown = "owner" in value ? value.owner : undefined;
  if (String(program) !== TOKEN_PROGRAM_ADDRESS) return false;
  const bytes = getBase64Encoder().encode(data);
  if (bytes.length !== getTokenSize()) return false;
  const token = getTokenDecoder().decode(bytes);
  return token.state !== AccountState.Uninitialized && token.mint === mint && token.owner === owner;
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
  accounts: BatchRpc,
  globalConfigAddress: Address
): Promise<Kit2> {
  let globalConfig: Kit2;
  try {
    globalConfig = await KVaultGlobalConfig.fetch(
      accounts as Kit2,
      globalConfigAddress as Kit2,
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
  // A floor the cluster's program cannot enforce is refused BEFORE any read:
  // klend-sdk turns every `minSharesOut` into `deposit_with_min_shares_out`,
  // which Kamino's devnet build does not implement, and the chain's answer
  // (Anchor 101, InstructionFallbackNotFound) arrives only after the caller has
  // been shown a floor. `assertPlanInstructionsSupported` re-checks the OUTPUT.
  if (
    input.minSharesOut !== undefined &&
    !kaminoClusterConfig(runtime.cluster).depositFloorSupported
  ) {
    throw depositFloorUnsupported(runtime.cluster);
  }

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
  // already there. Only a chain read distinguishes them, so the ATA rides the
  // reserve read rather than costing a request of its own.
  const [shareAta] = await findAssociatedTokenPda({
    owner: input.owner.address,
    mint: assetIdentity.shareMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const accounts = await readAccountBatch(rpc, [...vaultReserves(client, state), shareAta]).catch(
    failedBatch
  );
  const reserves = await loadStateOnlyReserves(
    runtime,
    input.vault,
    client,
    state,
    rpc,
    config.klendProgramId,
    config.slotDurationMs,
    accounts.rpc
  );
  const createsShareAccount = !listsAsShareAccount(
    accounts.account(shareAta),
    input.owner.address,
    assetIdentity.shareMint
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
  // Two concurrent reads: the owner's share accounts, and one batch with the
  // reserves, the global config and the lookup table. The batch is jsonParsed
  // so the table comes back parsed for kit's loader, while accounts without an
  // RPC parser come back as base64.
  const globalConfigAddress = await kvaultGlobalConfigAddress(config);
  const lookupTable = configuredLookupTable(
    state.vaultLookupTable === undefined ? undefined : String(state.vaultLookupTable)
  );
  const [shareAccountsResponse, accounts] = await Promise.all([
    rpc
      .getTokenAccountsByOwner(
        input.owner.address,
        { mint: assetIdentity.shareMint },
        { encoding: "jsonParsed" }
      )
      .send(),
    readAccountBatch(
      rpc,
      [
        ...vaultReserves(client, state),
        globalConfigAddress,
        ...(lookupTable === undefined ? [] : [lookupTable]),
      ],
      "jsonParsed"
    ).catch(failedBatch),
  ]);
  const [reserves, globalConfig, lookupTables] = await Promise.all([
    loadStateOnlyReserves(
      runtime,
      input.vault,
      client,
      state,
      rpc,
      config.klendProgramId,
      config.slotDurationMs,
      accounts.rpc
    ),
    loadKvaultGlobalConfig(runtime, input.vault, config, accounts.rpc, globalConfigAddress),
    // kit's own loader decodes the table from the batch: a structural relabel,
    // since the batch answers the one read it sends.
    loadVaultLookupTableAddresses(
      accounts.rpc as unknown as Parameters<typeof loadVaultLookupTableAddresses>[0],
      lookupTable
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
  // same transaction will observe. Without consolidation the ATA holds the
  // whole request, and the override hands the SDK the ATA balance the
  // share-account read above already returned, in the SDK's own arithmetic,
  // instead of letting it read the ATA again. The runtime assertion and
  // construction test intentionally fail an SDK upgrade that removes or
  // renames this method.
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
  } else {
    const ataBalance = new Decimal(consolidation.postConsolidationAtaBaseUnits.toString()).div(
      new Decimal(10).pow(state.sharesMintDecimals.toString())
    );
    const farmBalance = new Decimal(0);
    sdkClient.getUserSharesState = async () => ({
      userSharesAta: consolidation.shareAta,
      ataBalance,
      farmBalance,
      totalShares: ataBalance.add(farmBalance),
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
    // Keep rent in the owner-controlled share ATA. Neither a historical claim
    // nor same-transaction creation proves who funded all its lamports.
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

  const createsShareAccount = !shareAccounts.some(
    (account) => account.address === consolidation.shareAta
  );
  return assertPlanTargetsCluster({
    cluster: config.cluster,
    instructions: tagged.map((entry) => entry.instruction),
    lookupTables: Object.keys(lookupTables) as Address[],
    assetIdentity,
    accepted: { shares: acceptedShares },
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
 * `readKaminoPositions` re-reads every candidate in exact base units below and
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

interface BoundHolding {
  vault: Address;
  bound: Awaited<ReturnType<typeof bindVault>>;
  farms: string[];
  farmStates: string[];
}

interface ChainReads {
  reserves: AccountBatch;
  farmStates: AccountBatch;
}

/**
 * One owner's holdings in a page of vaults, every value read live.
 *
 * Two round trips after the caller's page slot, for any number of vaults: the
 * vault states in one batch, then the union of their reserves and the owner's
 * farm user states in a second batch, alongside one share-account read per
 * vault. Identical reads from owners hydrated together are one request
 * (`createKaminoReadRpc`).
 *
 * UNSTAKED shares are counted here rather than taken from the SDK, and that is
 * the whole point of the share-account read. `vault.getUserShares` sums its
 * token accounts through `getTokenAccountAmount`, which returns
 * `parsed.info.tokenAmount.uiAmount`, a JavaScript NUMBER: above 2^53 base
 * units that has already lost value. `amount` on the same parsed account is
 * the exact base-unit string, so this reads that and scales it by the share
 * mint itself.
 *
 * STAKED shares come from klend-sdk's own farm reader, run over the batched
 * user states for exactly the farms `getUserShares` visits; a vault with no
 * configured farm has none.
 *
 * `tokenValue` is shares x exchange rate. The rate read is allowed to fail
 * independently of the share read: a position whose size is known but whose
 * value is not is shown without a value, which is the module rule everywhere
 * else in Earn and strictly better than a fabricated number.
 *
 * Results follow `vaults`, duplicates included, and each settles on its own.
 */
export async function readKaminoPositions(
  runtime: KaminoRuntime,
  input: { vaults: readonly string[]; owner: Address; slot: bigint },
  assertActive: AssertActive = alwaysActive
): Promise<Array<PromiseSettledResult<KaminoPosition>>> {
  assertActive();
  const rpc = createKaminoReadRpc(runtime.rpcUrl);
  const settled = new Map<string, PromiseSettledResult<KaminoPosition>>();
  const vaults: Address[] = [];
  for (const reference of new Set(input.vaults)) {
    try {
      vaults.push(address(reference));
    } catch (reason) {
      settled.set(reference, { status: "rejected", reason });
    }
  }

  const vaultAccounts = await readAccountBatch(rpc, vaults).catch(failedBatch);
  assertActive();
  const holdings: BoundHolding[] = (
    await Promise.all(
      vaults.map(async (vault): Promise<BoundHolding[]> => {
        try {
          const bound = await bindVault(runtime, vault, assertActive, {
            rpc,
            accounts: vaultAccounts.rpc,
          });
          const farms = configuredFarms(bound.state);
          const farmStates = await Promise.all(
            farms.map(async (farm) =>
              String(await getFarmUserStatePDA(rpc as Kit2, input.owner as Kit2, farm as Kit2))
            )
          );
          return [{ vault, bound, farms, farmStates }];
        } catch (reason) {
          settled.set(vault, { status: "rejected", reason });
          return [];
        }
      })
    )
  ).flat();

  const [chains, shareReads] = await Promise.all([
    readReservesAndFarmStates(rpc, holdings, assertActive),
    mapSettledWithConcurrency(holdings, KAMINO_POSITION_READ_CONCURRENCY, assertActive, (holding) =>
      readUnstakedShareBaseUnits(rpc, input.owner, holding.bound.assetIdentity.shareMint)
    ),
  ]);
  assertActive();

  await Promise.all(
    holdings.map(async (holding, index) => {
      try {
        const value = await holdingFromReads(
          runtime,
          input,
          holding,
          chains[index],
          shareReads[index]
        );
        settled.set(holding.vault, { status: "fulfilled", value });
      } catch (reason) {
        settled.set(holding.vault, { status: "rejected", reason });
      }
    })
  );

  return input.vaults.map(
    (vault) =>
      settled.get(vault) ?? {
        status: "rejected",
        reason: vaultUnreadable(vault as Address, runtime.cluster, "position was not read"),
      }
  );
}

/** One wallet's holding in one vault, read live; see `readKaminoPositions`. */
export async function readKaminoPosition(
  runtime: KaminoRuntime,
  input: { vault: Address; owner: Address; slot: bigint },
  assertActive: AssertActive = alwaysActive
): Promise<KaminoPosition> {
  const [result] = await readKaminoPositions(
    runtime,
    { vaults: [input.vault], owner: input.owner, slot: input.slot },
    assertActive
  );
  if (result?.status === "fulfilled") return result.value;
  throw result?.reason ?? vaultUnreadable(input.vault, runtime.cluster, "position was not read");
}

/**
 * Every holding's reserves and farm user states in one batch, answered per
 * holding. Reserves only price a holding, so when that batch fails the farm
 * user states are re-read alone and each vault's reserves on their own: a
 * failed reserve read blanks only its own vault's value and never a share
 * count, as when each was its own request.
 */
async function readReservesAndFarmStates(
  rpc: AccountsReader,
  holdings: readonly BoundHolding[],
  assertActive: AssertActive
): Promise<ChainReads[]> {
  const reserves = holdings.map((holding) =>
    vaultReserves(holding.bound.client, holding.bound.state)
  );
  const farmStates = holdings.flatMap((holding) => holding.farmStates);
  try {
    const batch = await readAccountBatch(rpc, [...reserves.flat(), ...farmStates]);
    return holdings.map(() => ({ reserves: batch, farmStates: batch }));
  } catch (cause) {
    const [farmBatch, reserveReads] = await Promise.all([
      farmStates.length === 0
        ? failedBatch(cause)
        : readAccountBatch(rpc, farmStates).catch(failedBatch),
      mapSettledWithConcurrency(
        reserves,
        KAMINO_POSITION_READ_CONCURRENCY,
        assertActive,
        (addresses) => readAccountBatch(rpc, addresses)
      ),
    ]);
    return reserveReads.map((read) => ({
      reserves: read.status === "fulfilled" ? read.value : failedBatch(read.reason),
      farmStates: farmBatch,
    }));
  }
}

async function holdingFromReads(
  runtime: KaminoRuntime,
  input: { owner: Address; slot: bigint },
  holding: BoundHolding,
  chain: ChainReads,
  shareRead: PromiseSettledResult<bigint> | undefined
): Promise<KaminoPosition> {
  const { client, state, config, rpc, assetIdentity } = holding.bound;
  const shareDecimals = mintDecimals(state.sharesMintDecimals, "sharesMintDecimals");

  // The farm loop of `getUserSharesBalanceSingleVault`, over the batched user states.
  let stakedShares = new Decimal(0);
  for (const farm of holding.farms) {
    stakedShares = stakedShares.add(
      await getUserSharesInTokensStakedInFarm(
        chain.farmStates.rpc as Kit2,
        input.owner as Kit2,
        farm as Kit2,
        state.sharesMintDecimals.toNumber()
      )
    );
  }
  if (shareRead === undefined) {
    throw vaultUnreadable(holding.vault, runtime.cluster, "share accounts were not read");
  }
  if (shareRead.status === "rejected") throw shareRead.reason;
  const unstakedBase = shareRead.value;
  const shares = requireNonNegativeFiniteDecimal(
    "total share balance",
    new Decimal(formatDecimalAmount(unstakedBase, shareDecimals)).add(
      requireNonNegativeFiniteDecimal("staked share balance", stakedShares)
    )
  );

  let tokenValue: string | undefined;
  let rawRate: unknown;
  try {
    const reserves = await loadStateOnlyReserves(
      runtime,
      holding.vault,
      client,
      state,
      rpc,
      config.klendProgramId,
      config.slotDurationMs,
      chain.reserves.rpc
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
    vault: holding.vault,
    owner: input.owner,
    cluster: config.cluster,
    shares: shares.toFixed(),
    withdrawableShares: formatDecimalAmount(unstakedBase, shareDecimals),
    ...(tokenValue === undefined ? {} : { tokenValue }),
    tokenMint: assetIdentity.depositTokenMint,
    sharesMint: assetIdentity.shareMint,
  };
}

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
      String(allocation.reserve) !== DEFAULT_PUBLIC_KEY &&
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
    tokenDecimals,
    crankFundsBaseUnits: crankFunds,
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
  const accounts = await readAccountBatch(rpc, vaultReserves(client, state)).catch(failedBatch);
  const reserves = await loadStateOnlyReserves(
    runtime,
    input.vault,
    client,
    state,
    rpc,
    config.klendProgramId,
    config.slotDurationMs,
    accounts.rpc
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

  return deriveKaminoDepositQuote({
    sharesOutBaseUnits,
    shareDecimals,
    minimumDepositBaseUnits: bigintField("minimum deposit", state.minDepositAmount),
    ...pricing,
  });
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
  const globalConfigAddress = await kvaultGlobalConfigAddress(config);
  const accounts = await readAccountBatch(rpc, [
    ...vaultReserves(client, state),
    globalConfigAddress,
  ]).catch(failedBatch);
  const [reserves, globalConfig] = await Promise.all([
    loadStateOnlyReserves(
      runtime,
      input.vault,
      client,
      state,
      rpc,
      config.klendProgramId,
      config.slotDurationMs,
      accounts.rpc
    ),
    loadKvaultGlobalConfig(runtime, input.vault, config, accounts.rpc, globalConfigAddress),
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
