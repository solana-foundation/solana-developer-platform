import type { SolanaCluster } from "@sdp/types";
import type { VedaDeployment } from "@sdp/types/veda-programs";
import { internalError } from "../../errors";
import {
  assertRpcServesCluster,
  bytesEqual,
  fromBase64,
  type RpcAccount,
  type RpcProgramAccount,
  readIntLe,
  readUintLe,
  solanaRpcCall,
  toBase58,
  u64ToLeBytes,
} from "../../solana-rpc";

/**
 * Veda's `boring_vault_svm` account layouts, decoded straight off the chain.
 *
 * ── Why this reads bytes rather than calling the SDK ────────────────────────
 * `@vedatech/svm-sdk` can read all of this, and `@sdp/veda` uses it to. But that
 * SDK is built against `@solana/kit` 7 and this package's only dependency is
 * `@sdp/types`, because it runs inside the HOURLY catalogue cron in both
 * environments. Same rule that keeps klend-sdk out of the Kamino catalogue path.
 *
 * ── Why the layout is a TABLE, not a list of magic offsets ──────────────────
 * Unlike Kamino — whose offsets had to be located by matching live values
 * against an independent API — Veda publishes Anchor IDLs, and
 * `@vedatech/svm-sdk` ships them with a `programs.lock.json` recording the
 * commit and a SHA-256 of each. So every offset here is DERIVED from the
 * published field order, and stating that order explicitly is what makes it
 * checkable: `@sdp/veda` (which has the IDL) owns a test that recomputes this
 * table from `idl/boring_vault_svm.json` and fails if Veda's ABI moves.
 *
 * Borsh, so there is no padding: each field's offset is the sum of the sizes
 * before it, and the total is the account's exact byte length.
 */

const PUBKEY = 32;
const BOOL = 1;
const U8 = 1;
const U16 = 2;
const U32 = 4;
const U64 = 8;
const I64 = 8;
const U128 = 16;

/**
 * `BoringVault`, field by field, in IDL order. The nested `VaultState`,
 * `TellerState` and `VestingState` structs are flattened because Borsh lays
 * them out inline.
 */
const BORING_VAULT_FIELDS = [
  ["discriminator", 8],
  // --- config: VaultState ---
  ["config.vaultId", U64],
  ["config.authority", PUBKEY],
  ["config.pendingAuthority", PUBKEY],
  ["config.accountingPaused", BOOL],
  ["config.tellerPaused", BOOL],
  ["config.managePaused", BOOL],
  ["config.shareMint", PUBKEY],
  ["config.depositSubAccount", U8],
  ["config.withdrawSubAccount", U8],
  ["config.shareMover", PUBKEY],
  ["config.complianceMode", BOOL],
  ["config.complianceAuthority", PUBKEY],
  ["config.lockDurationSeconds", I64],
  // --- teller: TellerState ---
  ["teller.baseAsset", PUBKEY],
  ["teller.decimals", U8],
  ["teller.exchangeRate", U64],
  ["teller.exchangeRateHighWaterMark", U64],
  ["teller.platformFeesOwedInBaseAsset", U64],
  ["teller.performanceFeesOwedInBaseAsset", U64],
  ["teller.totalSharesLastUpdate", U64],
  ["teller.supplyLastUpdateTimestamp", U64],
  ["teller.platformPayoutAddress", PUBKEY],
  ["teller.performancePayoutAddress", PUBKEY],
  // biome-ignore lint/security/noSecrets: an IDL field name, not a credential
  ["teller.allowedExchangeRateChangeUpperBound", U16],
  // biome-ignore lint/security/noSecrets: an IDL field name, not a credential
  ["teller.allowedExchangeRateChangeLowerBound", U16],
  // biome-ignore lint/security/noSecrets: an IDL field name, not a credential
  ["teller.minimumUpdateDelayInSeconds", U32],
  ["teller.platformFeeBps", U16],
  ["teller.performanceFeeBps", U16],
  ["teller.withdrawAuthority", PUBKEY],
  ["teller.maxDeviationYieldBps", U16],
  ["teller.maxDeviationLossBps", U16],
  ["teller.vestingState.lastVirtualSharePrice", U128],
  ["teller.vestingState.vestingGains", U64],
  ["teller.vestingState.lastVestingUpdate", U64],
  ["teller.vestingState.startVestingTime", U64],
  ["teller.vestingState.endVestingTime", U64],
  ["teller.vestingState.cumulativeSupply", U128],
  ["teller.vestingState.vestingPeriodStart", U64],
  ["teller.lastStrategistUpdateTimestamp", U64],
  ["teller.stateLastUpdateTimestamp", U64],
  ["teller.depositCap", U64],
  ["teller.minimumVestDuration", U64],
  ["teller.maximumVestDuration", U64],
  ["teller.platformFeeRemainder", U64],
  ["teller.performanceFeeRemainder", U64],
  // --- accrualMode: VaultAccrualMode (fieldless enum, one byte) ---
  ["accrualMode", U8],
] as const;

/**
 * `AssetData`, up to the last field SDP reads.
 *
 * Truncated on purpose: the tail carries an `OracleSource` enum whose variants
 * differ in size, so the account has no fixed length and cannot be size-checked.
 * Everything SDP needs sits before it.
 */
const ASSET_DATA_FIELDS = [
  ["discriminator", 8],
  ["vaultId", U64],
  ["assetMint", PUBKEY],
  ["allowDeposits", BOOL],
  ["allowWithdrawals", BOOL],
  ["sharePremiumBps", U16],
  // biome-ignore lint/security/noSecrets: an IDL field name, not a credential
  ["isPeggedToBaseAsset", BOOL],
  ["inversePriceFeed", BOOL],
] as const;

function layout<const T extends readonly (readonly [string, number])[]>(
  fields: T
): { offsets: Record<T[number][0], number>; size: number } {
  const offsets = {} as Record<T[number][0], number>;
  let offset = 0;
  for (const [name, size] of fields) {
    offsets[name as T[number][0]] = offset;
    offset += size;
  }
  return { offsets, size: offset };
}

/**
 * The derived layouts, EXPORTED rather than private.
 *
 * Two callers need them and both are checks rather than conveniences: this
 * package's own decoder tests write fixture bytes at exact offsets, and
 * `@sdp/veda` — the package that actually holds the IDL — recomputes these
 * tables from `idl/boring_vault_svm.json` and fails if they disagree. A
 * hand-maintained offset table that nothing can contradict is how a silent ABI
 * change becomes a silently wrong share mint.
 */
export const VEDA_BORING_VAULT_LAYOUT = layout(BORING_VAULT_FIELDS);
export const VEDA_ASSET_DATA_LAYOUT = layout(ASSET_DATA_FIELDS);

const VAULT = VEDA_BORING_VAULT_LAYOUT;
const ASSET = VEDA_ASSET_DATA_LAYOUT;

/** Exact `BoringVault` account length — 512 bytes, derived from the table above. */
export const VEDA_BORING_VAULT_SIZE = VAULT.size;
/** Bytes of `AssetData` SDP reads; the account itself is longer and variable. */
export const VEDA_ASSET_DATA_MIN_SIZE = ASSET.size;

/** Anchor account discriminators, from the published IDL. */
export const VEDA_BORING_VAULT_DISCRIMINATOR = [35, 84, 44, 89, 150, 55, 236, 25] as const;
export const VEDA_ASSET_DATA_DISCRIMINATOR = [91, 115, 36, 105, 141, 93, 1, 135] as const;

/**
 * The default pubkey (all zero bytes), which Veda uses as "unset".
 *
 * On `teller.withdraw_authority` it means redemption is PERMISSIONLESS — the
 * SDK's own `resolveWithdrawalOptions` reads exactly this comparison to decide
 * whether instant withdrawal is available. Any other value is a named authority
 * that must sign, so SDP cannot promise an instant exit.
 */
export const VEDA_UNSET_AUTHORITY = "11111111111111111111111111111111";

/** What the catalogue reads out of one Veda vault account. */
export interface VedaVaultAccount {
  /** Vault-state address — the catalogue's `providerReference`. */
  address: string;
  vaultId: bigint;
  shareMint: string;
  /** The accounting asset the vault's exchange rate is denominated in. */
  baseAsset: string;
  shareDecimals: number;
  accountingPaused: boolean;
  tellerPaused: boolean;
  /** Named authority that must sign a redemption, or the unset pubkey. */
  withdrawAuthority: string;
  /** Seconds a deposit's shares stay locked. Zero means no lock. */
  lockDurationSeconds: bigint;
  platformFeeBps: number;
  performanceFeeBps: number;
  complianceMode: boolean;
}

/** One asset the vault is configured for. */
export interface VedaAssetAccount {
  vaultId: bigint;
  assetMint: string;
  allowDeposits: boolean;
  allowWithdrawals: boolean;
}

function pubkeyAt(data: Uint8Array, offset: number): string {
  return toBase58(data.subarray(offset, offset + PUBKEY));
}

/**
 * Decode a `BoringVault`, or `null` when the account is not one.
 *
 * Fail-closed, exactly like the Kamino decoder: the size and discriminator
 * together mean a program upgrade that changed the layout drops the row rather
 * than producing a plausible-looking one. Losing a vault from the shelf is a
 * visible gap; publishing a row whose share mint is read from the wrong offset
 * is a deposit aimed at the wrong token.
 */
export function decodeBoringVault(address: string, data: Uint8Array): VedaVaultAccount | null {
  if (data.length !== VEDA_BORING_VAULT_SIZE) return null;
  if (!bytesEqual(data, 0, [...VEDA_BORING_VAULT_DISCRIMINATOR])) return null;

  const shareMint = pubkeyAt(data, VAULT.offsets["config.shareMint"]);
  const baseAsset = pubkeyAt(data, VAULT.offsets["teller.baseAsset"]);
  // An all-zero pubkey is the system program, never a mint — the signature of
  // reading the wrong offset, and the one case the size check cannot catch.
  if (shareMint === VEDA_UNSET_AUTHORITY || baseAsset === VEDA_UNSET_AUTHORITY) return null;

  const shareDecimals = Number(readUintLe(data, VAULT.offsets["teller.decimals"], U8));
  // Token decimals are bounded at 9 on Solana; anything larger means the
  // decode is wrong, not that Veda invented a 200-decimal share.
  if (shareDecimals > 9) return null;

  return {
    address,
    vaultId: readUintLe(data, VAULT.offsets["config.vaultId"], U64),
    shareMint,
    baseAsset,
    shareDecimals,
    accountingPaused: data[VAULT.offsets["config.accountingPaused"]] === 1,
    tellerPaused: data[VAULT.offsets["config.tellerPaused"]] === 1,
    withdrawAuthority: pubkeyAt(data, VAULT.offsets["teller.withdrawAuthority"]),
    lockDurationSeconds: readIntLe(data, VAULT.offsets["config.lockDurationSeconds"], I64),
    platformFeeBps: Number(readUintLe(data, VAULT.offsets["teller.platformFeeBps"], U16)),
    performanceFeeBps: Number(readUintLe(data, VAULT.offsets["teller.performanceFeeBps"], U16)),
    complianceMode: data[VAULT.offsets["config.complianceMode"]] === 1,
  };
}

/** Decode an `AssetData`, or `null` when the account is not one. */
export function decodeAssetData(data: Uint8Array): VedaAssetAccount | null {
  if (data.length < VEDA_ASSET_DATA_MIN_SIZE) return null;
  if (!bytesEqual(data, 0, [...VEDA_ASSET_DATA_DISCRIMINATOR])) return null;

  const assetMint = pubkeyAt(data, ASSET.offsets.assetMint);
  if (assetMint === VEDA_UNSET_AUTHORITY) return null;

  return {
    vaultId: readUintLe(data, ASSET.offsets.vaultId, U64),
    assetMint,
    allowDeposits: data[ASSET.offsets.allowDeposits] === 1,
    allowWithdrawals: data[ASSET.offsets.allowWithdrawals] === 1,
  };
}

/** One catalogued vault with the assets it is configured for. */
export interface VedaVault {
  vault: VedaVaultAccount;
  assets: readonly VedaAssetAccount[];
}

function accountData(account: RpcAccount | RpcProgramAccount["account"]): Uint8Array | null {
  const encoded = account?.data?.[0];
  return typeof encoded === "string" ? fromBase64(encoded) : null;
}

/**
 * Every vault SDP catalogues for Veda on `cluster`, with its asset
 * configuration.
 *
 * **ALL-OR-NOTHING**, and this is the load-bearing property. The catalogue sync
 * DELETES rows a provider no longer lists, so a partial read does not degrade
 * gracefully — it delists whatever went unread. Every failure below throws:
 * an unreachable RPC, a genesis mismatch, a configured vault whose account is
 * missing, and an account that does not decode. The sync then skips its pass
 * and the catalogue keeps what it had.
 *
 * That is the opposite of the per-row tolerance the Kamino devnet path uses,
 * and deliberately so: Kamino reads a permissionless census where an odd
 * account is expected, while every address here is one SDP was given. A vault
 * on that list failing to decode is a fact about the deployment, not noise.
 */
export async function readVedaVaults(
  rpcUrl: string,
  cluster: SolanaCluster,
  deployment: VedaDeployment
): Promise<VedaVault[]> {
  const addresses = deployment.vaultStateAddresses;
  if (addresses.length === 0) return [];

  await assertRpcServesCluster("veda", rpcUrl, cluster);

  const response = await solanaRpcCall<{ value?: RpcAccount[] }>(
    "veda",
    rpcUrl,
    "getMultipleAccounts",
    [addresses, { encoding: "base64" }]
  );
  const accounts = response?.value;
  if (!Array.isArray(accounts) || accounts.length !== addresses.length) {
    throw internalError(
      `Veda vault read returned ${Array.isArray(accounts) ? accounts.length : "no"} accounts for ${addresses.length} configured vaults`
    );
  }

  const vaults: VedaVaultAccount[] = [];
  for (const [index, address] of addresses.entries()) {
    const data = accountData(accounts[index] ?? null);
    if (data === null) {
      throw internalError(
        `Veda vault ${address} does not exist on ${cluster}. Check the configured deployment addresses in @sdp/types/veda-programs.`
      );
    }
    const decoded = decodeBoringVault(address, data);
    if (decoded === null) {
      throw internalError(
        `Veda vault ${address} on ${cluster} is not a boring_vault_svm account, or its layout has changed.`
      );
    }
    vaults.push(decoded);
  }

  // One asset read per vault rather than one census across the program: Veda
  // deploys vaults per customer, so the program's account set includes other
  // integrators'. Filtering server-side by vault id keeps this read proportional
  // to SDP's own shelf and never materializes anyone else's configuration.
  const assetsByVault = await Promise.all(
    vaults.map((vault) => readVedaVaultAssets(rpcUrl, deployment, vault.vaultId))
  );

  return vaults.map((vault, index) => ({ vault, assets: assetsByVault[index] ?? [] }));
}

async function readVedaVaultAssets(
  rpcUrl: string,
  deployment: VedaDeployment,
  vaultId: bigint
): Promise<VedaAssetAccount[]> {
  const accounts = await solanaRpcCall<RpcProgramAccount[]>("veda", rpcUrl, "getProgramAccounts", [
    deployment.vaultProgramAddress,
    {
      encoding: "base64",
      // No `dataSize` filter: `AssetData` ends in an `OracleSource` enum whose
      // variants differ in length, so the account has no single size. The
      // discriminator plus the vault id is already an exact match.
      filters: [
        { memcmp: { offset: 0, bytes: toBase58(Uint8Array.from(VEDA_ASSET_DATA_DISCRIMINATOR)) } },
        { memcmp: { offset: ASSET.offsets.vaultId, bytes: toBase58(u64ToLeBytes(vaultId)) } },
      ],
    },
  ]);

  if (!Array.isArray(accounts)) {
    throw internalError(`Veda asset read for vault ${vaultId} returned no result array`);
  }

  const assets: VedaAssetAccount[] = [];
  for (const account of accounts) {
    const data = accountData(account.account ?? null);
    // ALL-OR-NOTHING here too: the filters said this account belongs to the
    // vault, so an entry arriving without data is a malformed read, and
    // skipping it would silently shrink the vault's asset list — possibly to
    // empty, which drops the row and lets the sync delist it.
    if (data === null) {
      throw internalError(
        `Veda asset account ${account.pubkey} returned no account data; refusing a partial asset read.`
      );
    }
    const decoded = decodeAssetData(data);
    // The filters already asserted the discriminator and the vault id, so a
    // failure here means the layout moved. Throwing keeps the deposit mints a
    // vault reports from silently shrinking to a subset.
    if (decoded === null) {
      throw internalError(
        `Veda asset account ${account.pubkey} did not decode; the boring_vault_svm layout may have changed.`
      );
    }
    if (decoded.vaultId !== vaultId) continue;
    assets.push(decoded);
  }

  return assets;
}
