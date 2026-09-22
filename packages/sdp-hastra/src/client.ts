import { createHash, randomBytes } from "node:crypto";
import { supportsPortfolioWallets } from "@sdp/earn/capabilities";
import { HastraEarnClient } from "@sdp/earn/providers/hastra/client";
import type {
  EarnRuntimeContext,
  EarnVaultDepositInput,
  EarnVaultDepositQuote,
  EarnVaultDepositQuoteInput,
  EarnVaultDepositQuoteProvider,
  EarnVaultDirectProvider,
  EarnVaultInstruction,
  EarnVaultParRedemptionCancelInput,
  EarnVaultParRedemptionLifecycleEvent,
  EarnVaultParRedemptionLifecycleInput,
  EarnVaultParRedemptionOptions,
  EarnVaultParRedemptionProvider,
  EarnVaultParRedemptionQuote,
  EarnVaultParRedemptionQuoteInput,
  EarnVaultParRedemptionRequestInput,
  EarnVaultParRedemptionRequestLookup,
  EarnVaultParRedemptionRequestPlan,
  EarnVaultParRedemptionRequestReadInput,
  EarnVaultPositionInput,
  EarnVaultPositionSnapshot,
  EarnVaultTransactionPlan,
  EarnVaultWithdrawalOptionsInput,
  EarnVaultWithdrawInput,
  EarnVaultWithdrawProvider,
  EarnVaultWithdrawQuote,
  EarnVaultWithdrawQuoteInput,
  EarnVaultWithdrawQuoteProvider,
} from "@sdp/earn/types";
import { AmountError, formatDecimalAmount, parseDecimalAmount } from "@sdp/solana/amount";
import { CLUSTER_BY_SDP_ENVIRONMENT, type SolanaCluster } from "@sdp/types";
import {
  type HastraDeployment,
  hastraDeployment,
  hastraDepositMints,
} from "@sdp/types/hastra-programs";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { SdpHastraError, type SdpHastraErrorCode } from "./errors";
import type {
  HastraRuntime,
  HastraSwapLeg,
  HastraSwapPort,
  HastraVaultOperationRunner,
} from "./types";

// Public Solana program addresses, never credentials.
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
// biome-ignore lint/security/noSecrets: public SPL Token program id, not a credential.
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
// biome-ignore lint/security/noSecrets: public Associated Token program id, not a credential.
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
// biome-ignore lint/security/noSecrets: public Jupiter aggregator program id, not a credential.
const JUPITER_AGGREGATOR_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const UPGRADEABLE_LOADER_ID = "BPFLoaderUpgradeab1e11111111111111111111111";

const TOKEN_DECIMALS = 6;
const U64_MAX = (1n << 64n) - 1n;
const I128_SIGN = 1n << 127n;
const I128_MODULUS = 1n << 128n;
const MAX_ADMINISTRATORS = 5;
const RPC_READ_TIMEOUT_MS = 30_000;
const CLASSIC_TOKEN_ACCOUNT_BYTES = 165;
const SIGNATURE_HISTORY_PAGE_SIZE = 1_000;
const MAX_SIGNATURE_HISTORY_PAGES = 10;

/** Native-only deposit and par-request ceiling. */
export const HASTRA_NATIVE_COMPUTE_UNIT_LIMIT = 600_000;
/** Native PRIME redemption plus an admitted Jupiter route. */
export const HASTRA_SWAP_COMPUTE_UNIT_LIMIT = 1_200_000;
/** Keep enough Jupiter accounts free for Hastra's own accounts and ATA setup. */
export const HASTRA_JUPITER_MAX_ACCOUNTS = 20;
/** Smallest non-zero wYLDS request the v0.0.6 program itself accepts. */
export const HASTRA_PAR_MINIMUM_ASSETS = "0.000001";
const HASTRA_PAR_MINIMUM_ASSET_ATOMS = 1n;
/**
 * A closed owner PDA has no cycle nonce. Wait beyond Solana's recent-blockhash
 * processing window before allowing the same address to represent a new debt.
 */
export const HASTRA_REQUEST_REUSE_COOLDOWN_BLOCKS = 200;

interface HastraClusterConfig {
  cluster: SolanaCluster;
  deployment: HastraDeployment;
  depositMint: string;
}

export function hastraClusterConfig(cluster: SolanaCluster): HastraClusterConfig {
  const deployment = hastraDeployment(cluster);
  if (!deployment) {
    throw new SdpHastraError(
      "DEPLOYMENT_NOT_CONFIGURED",
      `Hastra PRIME has no verified ${cluster} deployment.`
    );
  }
  const mints = hastraDepositMints(cluster);
  if (mints.length !== 1 || !mints[0]) {
    throw new SdpHastraError(
      "DEPLOYMENT_NOT_CONFIGURED",
      `Hastra expects exactly one USDC deposit mint on ${cluster} and found ${mints.length}.`
    );
  }
  return { cluster, deployment, depositMint: mints[0] };
}

function publicKey(field: string, value: string, code: SdpHastraErrorCode): PublicKey {
  try {
    return new PublicKey(value);
  } catch (cause) {
    throw new SdpHastraError(code, `${field} is not a valid Solana address.`, { cause });
  }
}

function pda(program: PublicKey, ...seeds: (string | Uint8Array)[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    seeds.map((seed) => (typeof seed === "string" ? Buffer.from(seed) : Buffer.from(seed))),
    program
  );
}

export interface HastraAddresses {
  mintConfig: string;
  mintVaultTokenAccountConfig: string;
  mintAuthority: string;
  redeemVaultAuthority: string;
  stakeConfig: string;
  stakeVaultTokenAccountConfig: string;
  stakeVaultAuthority: string;
  stakeMintAuthority: string;
  stakePriceConfig: string;
}

/** Deterministic v0.0.6 PDAs, exported so allowlist/audit tests can pin them. */
export function deriveHastraAddresses(deployment: HastraDeployment): HastraAddresses {
  const mintProgram = publicKey(
    "Hastra vault-mint program",
    deployment.vaultMintProgramAddress,
    "PROGRAM_MISMATCH"
  );
  const stakeProgram = publicKey(
    "Hastra vault-stake program",
    deployment.vaultStakeProgramAddress,
    "PROGRAM_MISMATCH"
  );
  const [mintConfig] = pda(mintProgram, "config");
  const [mintVaultTokenAccountConfig] = pda(
    mintProgram,
    "vault_token_account_config",
    mintConfig.toBytes()
  );
  const [mintAuthority] = pda(mintProgram, "mint_authority");
  const [redeemVaultAuthority] = pda(mintProgram, "redeem_vault_authority");
  const [stakeConfig] = pda(stakeProgram, "stake_config");
  const [stakeVaultTokenAccountConfig] = pda(
    stakeProgram,
    "stake_vault_token_account_config",
    stakeConfig.toBytes()
  );
  const [stakeVaultAuthority] = pda(stakeProgram, "vault_authority");
  const [stakeMintAuthority] = pda(stakeProgram, "mint_authority");
  const [stakePriceConfig] = pda(stakeProgram, "stake_price_config", stakeConfig.toBytes());
  return {
    mintConfig: mintConfig.toBase58(),
    mintVaultTokenAccountConfig: mintVaultTokenAccountConfig.toBase58(),
    mintAuthority: mintAuthority.toBase58(),
    redeemVaultAuthority: redeemVaultAuthority.toBase58(),
    stakeConfig: stakeConfig.toBase58(),
    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfig.toBase58(),
    stakeVaultAuthority: stakeVaultAuthority.toBase58(),
    stakeMintAuthority: stakeMintAuthority.toBase58(),
    stakePriceConfig: stakePriceConfig.toBase58(),
  };
}

function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), new PublicKey(TOKEN_PROGRAM_ID).toBuffer(), mint.toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID)
  )[0];
}

function redemptionRequestAddress(deployment: HastraDeployment, owner: PublicKey): PublicKey {
  return pda(
    new PublicKey(deployment.vaultMintProgramAddress),
    "redemption_request",
    owner.toBytes()
  )[0];
}

function legacyTicketAddress(deployment: HastraDeployment, owner: PublicKey): PublicKey {
  return pda(new PublicKey(deployment.vaultStakeProgramAddress), "ticket", owner.toBytes())[0];
}

async function readLegacyTicket(
  runtime: HastraRuntime,
  config: HastraClusterConfig,
  owner: PublicKey
): Promise<PublicKey | null> {
  const ticket = legacyTicketAddress(config.deployment, owner);
  const account = await getAccount(runtime, ticket.toBase58());
  if (!account) return null;
  assertOwned(account, config.deployment.vaultStakeProgramAddress, "Hastra legacy ticket");
  assertDiscriminator(account.data, "account", "UnbondingTicket");
  if (account.data.length < 64 || pubkeyAt(account.data, 8, "legacy ticket") !== owner.toBase58()) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      "Hastra's legacy unbonding ticket is truncated or belongs to another owner."
    );
  }
  return ticket;
}

function discriminator(namespace: "global" | "account" | "event", name: string): Buffer {
  return createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8);
}

function assertDiscriminator(data: Buffer, namespace: "account" | "event", name: string): void {
  const expected = discriminator(namespace, name);
  if (data.length < 8 || !data.subarray(0, 8).equals(expected)) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      `Hastra returned data with an unexpected ${name} discriminator.`
    );
  }
}

function canonicalAmount(value: string, label: string): { text: string; atoms: bigint } {
  let atoms: bigint;
  try {
    atoms = parseDecimalAmount(value, TOKEN_DECIMALS);
  } catch (cause) {
    if (cause instanceof AmountError) {
      throw new SdpHastraError(
        "INVALID_AMOUNT",
        `${label} is not usable at the ${TOKEN_DECIMALS}-decimal token scale: ${cause.message}`
      );
    }
    throw cause;
  }
  if (atoms <= 0n || atoms > U64_MAX) {
    throw new SdpHastraError("INVALID_AMOUNT", `${label} must be between one atom and u64::MAX.`);
  }
  return { text: formatDecimalAmount(atoms, TOKEN_DECIMALS), atoms };
}

function formatAtoms(atoms: bigint): string {
  return formatDecimalAmount(atoms, TOKEN_DECIMALS);
}

function pubkeyAt(data: Buffer, offset: number, label: string): string {
  if (offset < 0 || offset + 32 > data.length) {
    throw new SdpHastraError("PROGRAM_MISMATCH", `Hastra's ${label} account is truncated.`);
  }
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

function readU64(data: Buffer, offset: number, label: string): bigint {
  if (offset < 0 || offset + 8 > data.length) {
    throw new SdpHastraError("PROGRAM_MISMATCH", `Hastra's ${label} account is truncated.`);
  }
  return data.readBigUInt64LE(offset);
}

function readI64(data: Buffer, offset: number, label: string): bigint {
  if (offset < 0 || offset + 8 > data.length) {
    throw new SdpHastraError("PROGRAM_MISMATCH", `Hastra's ${label} account is truncated.`);
  }
  return data.readBigInt64LE(offset);
}

function readI128(data: Buffer, offset: number, label: string): bigint {
  if (offset < 0 || offset + 16 > data.length) {
    throw new SdpHastraError("PROGRAM_MISMATCH", `Hastra's ${label} account is truncated.`);
  }
  const unsigned = data.readBigUInt64LE(offset) | (data.readBigUInt64LE(offset + 8) << 64n);
  return unsigned >= I128_SIGN ? unsigned - I128_MODULUS : unsigned;
}

function skipPubkeyVector(data: Buffer, offset: number, label: string): number {
  if (offset + 4 > data.length) {
    throw new SdpHastraError("PROGRAM_MISMATCH", `Hastra's ${label} vector is truncated.`);
  }
  const length = data.readUInt32LE(offset);
  if (length > MAX_ADMINISTRATORS) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      `Hastra's ${label} vector exceeds the audited v0.0.6 bound.`
    );
  }
  const next = offset + 4 + length * 32;
  if (next > data.length) {
    throw new SdpHastraError("PROGRAM_MISMATCH", `Hastra's ${label} vector is truncated.`);
  }
  return next;
}

interface RpcAccount {
  data: Buffer;
  executable: boolean;
  owner: string;
}

interface RpcAccountWire {
  data?: [string, string] | string;
  executable?: boolean;
  owner?: string;
}

async function rpcRequest<T>(
  runtime: HastraRuntime,
  method: string,
  params: unknown[],
  code: SdpHastraErrorCode,
  description: string
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(runtime.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(RPC_READ_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new SdpHastraError(code, `The Solana RPC failed while ${description}.`, { cause });
  }
  if (!response.ok) {
    throw new SdpHastraError(
      code,
      `The Solana RPC answered HTTP ${response.status} while ${description}.`
    );
  }
  const body = (await response.json()) as { result?: T; error?: unknown };
  if (body.error !== undefined || body.result === undefined) {
    throw new SdpHastraError(code, `The Solana RPC returned an error while ${description}.`);
  }
  return body.result;
}

function decodeRpcAccount(value: RpcAccountWire | null, address: string): RpcAccount | null {
  if (value === null) return null;
  const encoded = Array.isArray(value.data) ? value.data[0] : value.data;
  if (
    typeof encoded !== "string" ||
    typeof value.owner !== "string" ||
    typeof value.executable !== "boolean"
  ) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      `The Solana RPC returned malformed account data for ${address}.`
    );
  }
  return { data: Buffer.from(encoded, "base64"), executable: value.executable, owner: value.owner };
}

async function getMultipleAccounts(
  runtime: HastraRuntime,
  addresses: readonly string[],
  code: SdpHastraErrorCode = "PROGRAM_MISMATCH"
): Promise<(RpcAccount | null)[]> {
  const result = await rpcRequest<{ value?: (RpcAccountWire | null)[] }>(
    runtime,
    "getMultipleAccounts",
    [addresses, { encoding: "base64", commitment: "confirmed" }],
    code,
    "reading Hastra accounts"
  );
  if (!Array.isArray(result.value) || result.value.length !== addresses.length) {
    throw new SdpHastraError(code, "The Solana RPC returned an incomplete Hastra account set.");
  }
  return result.value.map((value, index) => decodeRpcAccount(value, addresses[index] ?? "unknown"));
}

async function getAccount(
  runtime: HastraRuntime,
  address: string,
  code: SdpHastraErrorCode = "PROGRAM_MISMATCH",
  commitment: "confirmed" | "finalized" = "confirmed"
): Promise<RpcAccount | null> {
  const result = await rpcRequest<{ value?: RpcAccountWire | null }>(
    runtime,
    "getAccountInfo",
    [address, { encoding: "base64", commitment }],
    code,
    `reading account ${address}`
  );
  if (!("value" in result)) {
    throw new SdpHastraError(code, `The Solana RPC omitted account ${address}.`);
  }
  return decodeRpcAccount(result.value ?? null, address);
}

interface RpcSignatureHistoryEntry {
  signature?: string;
  slot?: number;
  err?: unknown;
}

interface RpcBlockIdentity {
  blockHeight?: number | null;
}

interface RpcTransactionLifecycle {
  meta?: { err?: unknown; logMessages?: string[] | null } | null;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * `RedemptionRequest` is derived from only the owner, so a still-valid cancel
 * or same-amount operator completion from the prior cycle would also name the
 * recreated account. The program cannot distinguish cycles. Refuse reuse
 * until more than the recent-blockhash window has elapsed in block-height
 * terms; using height rather than wall time remains safe across a chain halt.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: finalized state, authenticated paged history, and block-height expiry form one fail-closed proof.
async function assertRedemptionRequestReuseSafe(
  runtime: HastraRuntime,
  config: HastraClusterConfig,
  requestAddress: string
): Promise<void> {
  // A confirmed close can make the account disappear before the close itself
  // is finalized. Finalized state must also prove absence before finalized
  // history is allowed to identify the prior cycle's closing event.
  if ((await getAccount(runtime, requestAddress, "REQUEST_UNREADABLE", "finalized")) !== null) {
    throw new SdpHastraError(
      "REDEMPTION_REFUSED",
      "This wallet's prior Hastra request has not finalized closed yet."
    );
  }

  let before: string | undefined;
  let closingSlot: number | null = null;
  let exhausted = false;
  for (let page = 0; page < MAX_SIGNATURE_HISTORY_PAGES; page += 1) {
    const options: { commitment: "finalized"; limit: number; before?: string } = {
      commitment: "finalized",
      limit: SIGNATURE_HISTORY_PAGE_SIZE,
    };
    if (before) options.before = before;
    const history = await rpcRequest<RpcSignatureHistoryEntry[]>(
      runtime,
      "getSignaturesForAddress",
      [requestAddress, options],
      "REQUEST_UNREADABLE",
      "checking Hastra request-address history"
    );
    if (!Array.isArray(history)) {
      throw new SdpHastraError(
        "REQUEST_UNREADABLE",
        "The Solana RPC returned malformed Hastra request-address history."
      );
    }
    if (history.length === 0) {
      exhausted = true;
      break;
    }

    for (const entry of history) {
      if (!entry || typeof entry !== "object" || !Object.hasOwn(entry, "err")) {
        throw new SdpHastraError(
          "REQUEST_UNREADABLE",
          "The Solana RPC returned malformed Hastra request history."
        );
      }
      if (entry.err !== null) {
        continue;
      }
      if (
        typeof entry.signature !== "string" ||
        entry.signature.length === 0 ||
        !nonNegativeSafeInteger(entry.slot)
      ) {
        throw new SdpHastraError(
          "REQUEST_UNREADABLE",
          "The Solana RPC returned malformed successful Hastra request history."
        );
      }
      const transaction = await rpcRequest<RpcTransactionLifecycle | null>(
        runtime,
        "getTransaction",
        [
          entry.signature,
          { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 },
        ],
        "REQUEST_UNREADABLE",
        "authenticating prior Hastra request history"
      );
      if (
        !transaction?.meta ||
        transaction.meta.err !== null ||
        !Array.isArray(transaction.meta.logMessages)
      ) {
        // A successful finalized signature can only be classified as
        // unrelated after its complete logs are available. Skipping an
        // unavailable transaction could hide a newer close and authorize PDA
        // reuse from an older cycle before that newer close has expired.
        throw new SdpHastraError(
          "REQUEST_UNREADABLE",
          "The Solana RPC could not authenticate a successful Hastra request-history transaction."
        );
      }
      const events = parseParLifecycleEvents(config, {
        providerReference: config.deployment.primeMint,
        requestAddress,
        logs: transaction.meta.logMessages,
        // Only event authenticity matters here; block height, not wall time,
        // enforces expiry below.
        blockTime: "0",
        shareDecimals: TOKEN_DECIMALS,
        assetDecimals: TOKEN_DECIMALS,
      });
      if (
        events.some(
          (event) => event.kind === "redemptionCancelled" || event.kind === "redemptionFulfilled"
        )
      ) {
        closingSlot = entry.slot;
        break;
      }
      if (events.some((event) => event.kind === "redemptionRequested")) {
        // We scan newest to oldest. Reaching a creation without first seeing
        // its authenticated close means finalized account state and history
        // disagree, so an older cycle's close cannot safely authorize reuse.
        throw new SdpHastraError(
          "REQUEST_UNREADABLE",
          "The Solana RPC could not prove how the prior Hastra request closed."
        );
      }
    }
    if (closingSlot !== null) break;
    const last = history.at(-1);
    if (history.length < SIGNATURE_HISTORY_PAGE_SIZE) {
      exhausted = true;
      break;
    }
    if (typeof last?.signature !== "string" || last.signature.length === 0) {
      throw new SdpHastraError(
        "REQUEST_UNREADABLE",
        "The Solana RPC returned an unpageable Hastra request history."
      );
    }
    before = last.signature;
  }
  if (closingSlot === null) {
    if (!exhausted) {
      throw new SdpHastraError(
        "REQUEST_UNREADABLE",
        "Hastra request history is too large to prove safe PDA reuse."
      );
    }
    // No authenticated Hastra lifecycle ever used this deterministic address;
    // unrelated or failed mentions do not turn a first request into a reuse.
    return;
  }
  const [closingBlock, currentBlockHeight] = await Promise.all([
    rpcRequest<RpcBlockIdentity | null>(
      runtime,
      "getBlock",
      [closingSlot, { commitment: "finalized", transactionDetails: "none", rewards: false }],
      "REQUEST_UNREADABLE",
      "reading the last Hastra request block"
    ),
    rpcRequest<number>(
      runtime,
      "getBlockHeight",
      [{ commitment: "finalized" }],
      "REQUEST_UNREADABLE",
      "reading finalized Solana block height"
    ),
  ]);
  const closingBlockHeight = closingBlock?.blockHeight;
  if (!nonNegativeSafeInteger(closingBlockHeight) || !nonNegativeSafeInteger(currentBlockHeight)) {
    throw new SdpHastraError(
      "REQUEST_UNREADABLE",
      "The Solana RPC could not prove that Hastra's prior request transactions expired."
    );
  }
  if (currentBlockHeight <= closingBlockHeight + HASTRA_REQUEST_REUSE_COOLDOWN_BLOCKS) {
    throw new SdpHastraError(
      "REDEMPTION_REFUSED",
      "This wallet's prior Hastra request closed too recently. Wait for its signed transactions " +
        "to expire before opening another request."
    );
  }
}

function requiredAccount(account: RpcAccount | null, address: string): RpcAccount {
  if (!account) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      `Hastra's required account ${address} does not exist.`
    );
  }
  return account;
}

function assertOwned(account: RpcAccount, owner: string, label: string): void {
  if (account.owner !== owner) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      `${label} is owned by ${account.owner}, not the pinned ${owner}.`
    );
  }
}

interface MintConfigState {
  vault: string;
  mint: string;
  vaultAuthority: string;
  redeemVault: string;
  bump: number;
  paused: boolean;
  allowedExternalMintProgram: string;
}

function decodeMintConfig(account: RpcAccount, program: string): MintConfigState {
  assertOwned(account, program, "Hastra vault-mint config");
  const data = account.data;
  assertDiscriminator(data, "account", "Config");
  let offset = 8;
  const vault = pubkeyAt(data, offset, "vault-mint config");
  offset += 32;
  const mint = pubkeyAt(data, offset, "vault-mint config");
  offset += 32;
  offset = skipPubkeyVector(data, offset, "freeze administrators");
  offset = skipPubkeyVector(data, offset, "rewards administrators");
  const vaultAuthority = pubkeyAt(data, offset, "vault-mint config");
  offset += 32;
  const redeemVault = pubkeyAt(data, offset, "vault-mint config");
  offset += 32;
  if (offset + 34 > data.length) {
    throw new SdpHastraError("PROGRAM_MISMATCH", "Hastra's vault-mint config is truncated.");
  }
  const bump = data[offset] ?? -1;
  const pausedByte = data[offset + 1];
  if (pausedByte !== 0 && pausedByte !== 1) {
    throw new SdpHastraError("PROGRAM_MISMATCH", "Hastra's vault-mint pause flag is invalid.");
  }
  return {
    vault,
    mint,
    vaultAuthority,
    redeemVault,
    bump,
    paused: pausedByte === 1,
    allowedExternalMintProgram: pubkeyAt(data, offset + 2, "vault-mint config"),
  };
}

interface StakeConfigState {
  vault: string;
  mint: string;
  bump: number;
  paused: boolean;
}

function decodeStakeConfig(account: RpcAccount, program: string): StakeConfigState {
  assertOwned(account, program, "Hastra vault-stake config");
  const data = account.data;
  assertDiscriminator(data, "account", "StakeConfig");
  let offset = 8;
  const vault = pubkeyAt(data, offset, "vault-stake config");
  offset += 32;
  const mint = pubkeyAt(data, offset, "vault-stake config");
  offset += 32 + 8; // deprecated unbonding_period remains in the deployed layout
  offset = skipPubkeyVector(data, offset, "stake freeze administrators");
  offset = skipPubkeyVector(data, offset, "stake rewards administrators");
  if (offset + 2 > data.length) {
    throw new SdpHastraError("PROGRAM_MISMATCH", "Hastra's vault-stake config is truncated.");
  }
  const bump = data[offset] ?? -1;
  const pausedByte = data[offset + 1];
  if (pausedByte !== 0 && pausedByte !== 1) {
    throw new SdpHastraError("PROGRAM_MISMATCH", "Hastra's vault-stake pause flag is invalid.");
  }
  return { vault, mint, bump, paused: pausedByte === 1 };
}

interface StakePriceState {
  price: bigint;
  scale: bigint;
  timestamp: bigint;
  maxStaleness: bigint;
  bump: number;
}

function decodeStakePrice(account: RpcAccount, program: string): StakePriceState {
  assertOwned(account, program, "Hastra stake-price config");
  const data = account.data;
  assertDiscriminator(data, "account", "StakePriceConfig");
  if (data.length < 177) {
    throw new SdpHastraError("PROGRAM_MISMATCH", "Hastra's stake-price config is truncated.");
  }
  const price = readI128(data, 136, "stake-price config");
  const scale = readU64(data, 152, "stake-price config");
  const timestamp = readI64(data, 160, "stake-price config");
  const maxStaleness = readI64(data, 168, "stake-price config");
  const bump = data[176] ?? -1;
  if (scale === 0n || maxStaleness < 0n) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      "Hastra's stake-price scale or staleness bound is invalid."
    );
  }
  return { price, scale, timestamp, maxStaleness, bump };
}

function decodeSingletonPubkeyConfig(
  account: RpcAccount,
  program: string,
  discriminatorName: string,
  label: string
): { address: string; bump: number } {
  assertOwned(account, program, label);
  assertDiscriminator(account.data, "account", discriminatorName);
  if (account.data.length < 41) {
    throw new SdpHastraError("PROGRAM_MISMATCH", `${label} is truncated.`);
  }
  return { address: pubkeyAt(account.data, 8, label), bump: account.data[40] ?? -1 };
}

function decodeStakeVaultConfig(
  account: RpcAccount,
  program: string
): { vaultTokenAccount: string; vaultAuthority: string; bump: number } {
  assertOwned(account, program, "Hastra stake-vault-token config");
  // biome-ignore lint/security/noSecrets: public Anchor account type name, not a credential.
  assertDiscriminator(account.data, "account", "StakeVaultTokenAccountConfig");
  if (account.data.length < 73) {
    throw new SdpHastraError("PROGRAM_MISMATCH", "Hastra's stake-vault-token config is truncated.");
  }
  return {
    vaultTokenAccount: pubkeyAt(account.data, 8, "stake-vault-token config"),
    vaultAuthority: pubkeyAt(account.data, 40, "stake-vault-token config"),
    bump: account.data[72] ?? -1,
  };
}

function decodeMint(
  account: RpcAccount,
  address: string,
  expectedAuthority: string | null
): { supply: bigint } {
  assertOwned(account, TOKEN_PROGRAM_ID, `Hastra mint ${address}`);
  if (account.data.length < 82 || account.data[45] !== 1 || account.data[44] !== TOKEN_DECIMALS) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      `Hastra mint ${address} is uninitialized or no longer uses ${TOKEN_DECIMALS} decimals.`
    );
  }
  if (expectedAuthority !== null) {
    const authorityOption = account.data.readUInt32LE(0);
    const authority = pubkeyAt(account.data, 4, `mint ${address}`);
    if (authorityOption !== 1 || authority !== expectedAuthority) {
      throw new SdpHastraError(
        "PROGRAM_MISMATCH",
        `Hastra mint ${address} no longer has the pinned program mint authority.`
      );
    }
  }
  return { supply: readU64(account.data, 36, `mint ${address}`) };
}

function decodeTokenAccount(
  account: RpcAccount,
  label: string,
  expectedMint: string,
  expectedOwner: string
): { amount: bigint; frozen: boolean } {
  assertOwned(account, TOKEN_PROGRAM_ID, label);
  if (
    account.data.length < 165 ||
    pubkeyAt(account.data, 0, label) !== expectedMint ||
    pubkeyAt(account.data, 32, label) !== expectedOwner
  ) {
    throw new SdpHastraError("PROGRAM_MISMATCH", `${label} has an unexpected mint or authority.`);
  }
  const state = account.data[108];
  if (state !== 1 && state !== 2) {
    throw new SdpHastraError("PROGRAM_MISMATCH", `${label} is not an initialized SPL account.`);
  }
  return { amount: readU64(account.data, 64, label), frozen: state === 2 };
}

function assertOwnerTokenUsable(
  account: RpcAccount | null,
  label: string,
  mint: string,
  owner: string,
  code: "DEPOSIT_REFUSED" | "WITHDRAW_REFUSED" | "REDEMPTION_REFUSED",
  requiredAmount?: bigint
): { amount: bigint; frozen: false } {
  if (!account) {
    throw new SdpHastraError(code, `${label} does not exist.`);
  }
  const decoded = decodeTokenAccount(account, label, mint, owner);
  if (decoded.frozen) {
    throw new SdpHastraError(code, `${label} is frozen and cannot move tokens.`);
  }
  if (requiredAmount !== undefined && decoded.amount < requiredAmount) {
    throw new SdpHastraError(code, `${label} does not hold the requested amount.`);
  }
  return { amount: decoded.amount, frozen: false };
}

function assertExistingOwnerTokenUsable(
  account: RpcAccount | null,
  label: string,
  mint: string,
  owner: string,
  code: "DEPOSIT_REFUSED" | "WITHDRAW_REFUSED" | "REDEMPTION_REFUSED"
): { amount: bigint; frozen: false } | null {
  if (!account) return null;
  return assertOwnerTokenUsable(account, label, mint, owner, code);
}

interface HastraState {
  addresses: HastraAddresses;
  mintConfig: MintConfigState;
  stakeConfig: StakeConfigState;
  stakePrice: StakePriceState;
  mintVaultTokenAccount: string;
  stakeVaultTokenAccount: string;
  stakeVaultLiquidity: bigint;
  depositVaultFrozen: boolean;
  redeemVaultFrozen: boolean;
  stakeVaultFrozen: boolean;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      `${label} drifted from SDP's pinned Hastra v0.0.6 deployment.`
    );
  }
}

async function loadHastraState(
  runtime: HastraRuntime,
  config: HastraClusterConfig
): Promise<HastraState> {
  const { deployment } = config;
  const addresses = deriveHastraAddresses(deployment);
  const firstAddresses = [
    deployment.vaultMintProgramAddress,
    deployment.vaultStakeProgramAddress,
    addresses.mintConfig,
    addresses.mintVaultTokenAccountConfig,
    addresses.stakeConfig,
    addresses.stakeVaultTokenAccountConfig,
    addresses.stakePriceConfig,
    config.depositMint,
    deployment.wYldsMint,
    deployment.primeMint,
  ] as const;
  const first = await getMultipleAccounts(runtime, firstAddresses);
  const [mintProgram, stakeProgram] = first;
  if (
    !mintProgram?.executable ||
    mintProgram.owner !== UPGRADEABLE_LOADER_ID ||
    !stakeProgram?.executable ||
    stakeProgram.owner !== UPGRADEABLE_LOADER_ID
  ) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      "A pinned Hastra program is missing, non-executable, or no longer upgradeable-program owned."
    );
  }

  const mintConfig = decodeMintConfig(
    requiredAccount(first[2] ?? null, addresses.mintConfig),
    deployment.vaultMintProgramAddress
  );
  const mintVaultConfig = decodeSingletonPubkeyConfig(
    requiredAccount(first[3] ?? null, addresses.mintVaultTokenAccountConfig),
    deployment.vaultMintProgramAddress,
    "VaultTokenAccountConfig",
    "Hastra vault-mint token-account config"
  );
  const stakeConfig = decodeStakeConfig(
    requiredAccount(first[4] ?? null, addresses.stakeConfig),
    deployment.vaultStakeProgramAddress
  );
  const stakeVaultConfig = decodeStakeVaultConfig(
    requiredAccount(first[5] ?? null, addresses.stakeVaultTokenAccountConfig),
    deployment.vaultStakeProgramAddress
  );
  const stakePrice = decodeStakePrice(
    requiredAccount(first[6] ?? null, addresses.stakePriceConfig),
    deployment.vaultStakeProgramAddress
  );

  decodeMint(requiredAccount(first[7] ?? null, config.depositMint), config.depositMint, null);
  decodeMint(
    requiredAccount(first[8] ?? null, deployment.wYldsMint),
    deployment.wYldsMint,
    addresses.mintAuthority
  );
  decodeMint(
    requiredAccount(first[9] ?? null, deployment.primeMint),
    deployment.primeMint,
    addresses.stakeMintAuthority
  );

  assertEqual(mintConfig.vault, config.depositMint, "Hastra vault-mint deposit mint");
  assertEqual(mintConfig.mint, deployment.wYldsMint, "Hastra vault-mint receipt mint");
  assertEqual(
    mintConfig.allowedExternalMintProgram,
    deployment.vaultStakeProgramAddress,
    "Hastra external mint program"
  );
  assertEqual(stakeConfig.vault, deployment.wYldsMint, "Hastra stake vault mint");
  assertEqual(stakeConfig.mint, deployment.primeMint, "Hastra PRIME mint");
  assertEqual(
    stakeVaultConfig.vaultAuthority,
    addresses.stakeVaultAuthority,
    "Hastra stake vault authority"
  );

  const mintProgramKey = new PublicKey(deployment.vaultMintProgramAddress);
  const stakeProgramKey = new PublicKey(deployment.vaultStakeProgramAddress);
  assertEqual(mintConfig.bump, pda(mintProgramKey, "config")[1], "Hastra vault-mint config bump");
  assertEqual(
    mintVaultConfig.bump,
    pda(
      mintProgramKey,
      "vault_token_account_config",
      new PublicKey(addresses.mintConfig).toBytes()
    )[1],
    "Hastra vault-token config bump"
  );
  assertEqual(
    stakeConfig.bump,
    pda(stakeProgramKey, "stake_config")[1],
    "Hastra stake config bump"
  );
  assertEqual(
    stakeVaultConfig.bump,
    pda(
      stakeProgramKey,
      "stake_vault_token_account_config",
      new PublicKey(addresses.stakeConfig).toBytes()
    )[1],
    "Hastra stake-vault config bump"
  );
  assertEqual(
    stakePrice.bump,
    pda(stakeProgramKey, "stake_price_config", new PublicKey(addresses.stakeConfig).toBytes())[1],
    "Hastra stake-price config bump"
  );

  if (mintConfig.redeemVault === SYSTEM_PROGRAM_ID) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      "Hastra's operator redemption vault has not been initialized."
    );
  }
  const vaultAddresses = [
    mintVaultConfig.address,
    mintConfig.redeemVault,
    stakeVaultConfig.vaultTokenAccount,
  ] as const;
  const vaultAccounts = await getMultipleAccounts(runtime, vaultAddresses);
  const depositVault = decodeTokenAccount(
    requiredAccount(vaultAccounts[0] ?? null, mintVaultConfig.address),
    "Hastra USDC deposit vault",
    config.depositMint,
    // Unlike the redeem and stake authorities, this is not a PDA in v0.0.6:
    // initialize records the pre-existing deposit token account's owner in
    // Config and Deposit constrains the vault against that stored authority.
    mintConfig.vaultAuthority
  );
  const redeemVault = decodeTokenAccount(
    requiredAccount(vaultAccounts[1] ?? null, mintConfig.redeemVault),
    "Hastra USDC redemption vault",
    config.depositMint,
    addresses.redeemVaultAuthority
  );
  const stakeVault = decodeTokenAccount(
    requiredAccount(vaultAccounts[2] ?? null, stakeVaultConfig.vaultTokenAccount),
    "Hastra wYLDS stake vault",
    deployment.wYldsMint,
    addresses.stakeVaultAuthority
  );

  return {
    addresses,
    mintConfig,
    stakeConfig,
    stakePrice,
    mintVaultTokenAccount: mintVaultConfig.address,
    stakeVaultTokenAccount: stakeVaultConfig.vaultTokenAccount,
    stakeVaultLiquidity: stakeVault.amount,
    depositVaultFrozen: depositVault.frozen,
    redeemVaultFrozen: redeemVault.frozen,
    stakeVaultFrozen: stakeVault.frozen,
  };
}

function computeUnitLimitInstruction(units: number): EarnVaultInstruction {
  const data = Buffer.alloc(5);
  data[0] = 2; // ComputeBudgetInstruction::SetComputeUnitLimit
  data.writeUInt32LE(units, 1);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], data: data.toString("base64") };
}

function createAssociatedTokenInstruction(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey
): EarnVaultInstruction {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
    accounts: [
      { address: payer.toBase58(), role: 3 },
      { address: associatedTokenAddress(owner, mint).toBase58(), role: 1 },
      { address: owner.toBase58(), role: 0 },
      { address: mint.toBase58(), role: 0 },
      { address: SYSTEM_PROGRAM_ID, role: 0 },
      { address: TOKEN_PROGRAM_ID, role: 0 },
    ],
    // Associated Token Program: CreateIdempotent
    data: Buffer.from([1]).toString("base64"),
  };
}

function web3Instruction(instruction: {
  programId: PublicKey;
  keys: readonly { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
  data: Buffer;
}): EarnVaultInstruction {
  return {
    programAddress: instruction.programId.toBase58(),
    accounts: instruction.keys.map((account) => ({
      address: account.pubkey.toBase58(),
      role: (account.isSigner ? 2 : 0) + (account.isWritable ? 1 : 0),
    })),
    data: instruction.data.toString("base64"),
  };
}

function initializeClassicTokenAccountInstruction(
  account: PublicKey,
  mint: PublicKey,
  owner: PublicKey
): EarnVaultInstruction {
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [
      { address: account.toBase58(), role: 1 },
      { address: mint.toBase58(), role: 0 },
    ],
    // SPL Token: InitializeAccount3 { owner }.
    data: Buffer.concat([Buffer.from([18]), owner.toBuffer()]).toString("base64"),
  };
}

function transferClassicTokensInstruction(
  source: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint
): EarnVaultInstruction {
  const data = Buffer.alloc(9);
  data[0] = 3; // SPL Token: Transfer
  data.writeBigUInt64LE(amount, 1);
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [
      { address: source.toBase58(), role: 1 },
      { address: destination.toBase58(), role: 1 },
      { address: owner.toBase58(), role: 2 },
    ],
    data: data.toString("base64"),
  };
}

function closeClassicTokenAccountInstruction(
  account: PublicKey,
  refundTo: PublicKey,
  owner: PublicKey
): EarnVaultInstruction {
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [
      { address: account.toBase58(), role: 1 },
      { address: refundTo.toBase58(), role: 1 },
      { address: owner.toBase58(), role: 2 },
    ],
    data: Buffer.from([9]).toString("base64"), // SPL Token: CloseAccount
  };
}

interface TransientTokenAccountPlan {
  address: PublicKey;
  setupInstructions: EarnVaultInstruction[];
  settleInstructions: EarnVaultInstruction[];
}

/**
 * Isolate a price-sensitive redeem in an account that cannot be dusted before
 * execution. Moving exactly `amount` out and then closing it is an on-chain
 * equality assertion: a lower live output makes the transfer fail, while a
 * higher output leaves a balance and makes the close fail. The whole composed
 * transaction rolls back in either case and callers rebuild at the new rate.
 */
async function transientTokenAccountPlan(args: {
  runtime: HastraRuntime;
  payer: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  destination: PublicKey;
  refundTo: PublicKey;
  amount: bigint;
}): Promise<TransientTokenAccountPlan> {
  const rentLamports = await rpcRequest<number>(
    args.runtime,
    // biome-ignore lint/security/noSecrets: public Solana JSON-RPC method name, not a credential.
    "getMinimumBalanceForRentExemption",
    [CLASSIC_TOKEN_ACCOUNT_BYTES, { commitment: "confirmed" }],
    "PROGRAM_MISMATCH",
    "reading classic token-account rent"
  );
  if (!nonNegativeSafeInteger(rentLamports)) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      "The Solana RPC returned an invalid classic token-account rent."
    );
  }
  const seed = `sdp-hastra-${randomBytes(10).toString("hex")}`;
  const tokenProgram = new PublicKey(TOKEN_PROGRAM_ID);
  const address = await PublicKey.createWithSeed(args.owner, seed, tokenProgram);
  const create = SystemProgram.createAccountWithSeed({
    fromPubkey: args.payer,
    newAccountPubkey: address,
    basePubkey: args.owner,
    seed,
    lamports: rentLamports,
    space: CLASSIC_TOKEN_ACCOUNT_BYTES,
    programId: tokenProgram,
  });
  return {
    address,
    setupInstructions: [
      web3Instruction(create),
      initializeClassicTokenAccountInstruction(address, args.mint, args.owner),
    ],
    settleInstructions: [
      transferClassicTokensInstruction(address, args.destination, args.owner, args.amount),
      closeClassicTokenAccountInstruction(address, args.refundTo, args.owner),
    ],
  };
}

function anchorAmountData(name: string, amount: bigint): string {
  const data = Buffer.alloc(16);
  discriminator("global", name).copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  return data.toString("base64");
}

function anchorNoArgsData(name: string): string {
  return discriminator("global", name).toString("base64");
}

function mintDepositInstruction(args: {
  config: HastraClusterConfig;
  state: HastraState;
  owner: PublicKey;
  userUsdc: PublicKey;
  userWylds: PublicKey;
  amount: bigint;
}): EarnVaultInstruction {
  return {
    programAddress: args.config.deployment.vaultMintProgramAddress,
    accounts: [
      { address: args.state.addresses.mintConfig, role: 0 },
      { address: args.state.addresses.mintVaultTokenAccountConfig, role: 0 },
      { address: args.state.mintVaultTokenAccount, role: 1 },
      { address: args.config.deployment.wYldsMint, role: 1 },
      { address: args.state.addresses.mintAuthority, role: 0 },
      { address: args.owner.toBase58(), role: 2 },
      { address: args.userUsdc.toBase58(), role: 1 },
      { address: args.userWylds.toBase58(), role: 1 },
      { address: TOKEN_PROGRAM_ID, role: 0 },
    ],
    data: anchorAmountData("deposit", args.amount),
  };
}

function stakeDepositInstruction(args: {
  config: HastraClusterConfig;
  state: HastraState;
  owner: PublicKey;
  userWylds: PublicKey;
  userPrime: PublicKey;
  amount: bigint;
}): EarnVaultInstruction {
  return {
    programAddress: args.config.deployment.vaultStakeProgramAddress,
    accounts: [
      { address: args.state.addresses.stakeConfig, role: 0 },
      { address: args.state.addresses.stakeVaultTokenAccountConfig, role: 0 },
      { address: args.state.stakeVaultTokenAccount, role: 1 },
      { address: args.state.addresses.stakeVaultAuthority, role: 0 },
      { address: args.config.deployment.primeMint, role: 1 },
      { address: args.config.deployment.wYldsMint, role: 1 },
      { address: args.state.addresses.stakeMintAuthority, role: 0 },
      { address: args.owner.toBase58(), role: 2 },
      { address: args.userWylds.toBase58(), role: 1 },
      { address: args.userPrime.toBase58(), role: 1 },
      { address: args.state.addresses.stakePriceConfig, role: 0 },
      { address: TOKEN_PROGRAM_ID, role: 0 },
    ],
    data: anchorAmountData("deposit", args.amount),
  };
}

function stakeRedeemInstruction(args: {
  config: HastraClusterConfig;
  state: HastraState;
  owner: PublicKey;
  userWylds: PublicKey;
  userPrime: PublicKey;
  legacyTicket: PublicKey | null;
  amount: bigint;
}): EarnVaultInstruction {
  return {
    programAddress: args.config.deployment.vaultStakeProgramAddress,
    accounts: [
      { address: args.state.addresses.stakeConfig, role: 0 },
      { address: args.state.addresses.stakeVaultTokenAccountConfig, role: 0 },
      { address: args.state.stakeVaultTokenAccount, role: 1 },
      { address: args.state.addresses.stakeVaultAuthority, role: 0 },
      { address: args.owner.toBase58(), role: 3 },
      {
        // Anchor 0.31's Option<Account> sentinel is the executing program id.
        address: args.legacyTicket?.toBase58() ?? args.config.deployment.vaultStakeProgramAddress,
        role: 1,
      },
      { address: args.userWylds.toBase58(), role: 1 },
      { address: args.userPrime.toBase58(), role: 1 },
      { address: args.config.deployment.primeMint, role: 1 },
      { address: args.config.deployment.wYldsMint, role: 1 },
      { address: args.state.addresses.stakePriceConfig, role: 0 },
      { address: TOKEN_PROGRAM_ID, role: 0 },
    ],
    data: anchorAmountData("redeem", args.amount),
  };
}

function parRequestInstruction(args: {
  config: HastraClusterConfig;
  state: HastraState;
  owner: PublicKey;
  userWylds: PublicKey;
  request: PublicKey;
  amount: bigint;
}): EarnVaultInstruction {
  return {
    programAddress: args.config.deployment.vaultMintProgramAddress,
    accounts: [
      { address: args.owner.toBase58(), role: 3 },
      { address: args.userWylds.toBase58(), role: 1 },
      { address: args.request.toBase58(), role: 1 },
      { address: args.state.addresses.redeemVaultAuthority, role: 0 },
      { address: args.config.deployment.wYldsMint, role: 0 },
      { address: args.state.addresses.mintConfig, role: 0 },
      { address: SYSTEM_PROGRAM_ID, role: 0 },
      { address: TOKEN_PROGRAM_ID, role: 0 },
    ],
    data: anchorAmountData("request_redeem", args.amount),
  };
}

function parCancelInstruction(args: {
  config: HastraClusterConfig;
  state: HastraState;
  owner: PublicKey;
  userWylds: PublicKey;
  request: PublicKey;
}): EarnVaultInstruction {
  return {
    programAddress: args.config.deployment.vaultMintProgramAddress,
    accounts: [
      { address: args.owner.toBase58(), role: 3 },
      { address: args.userWylds.toBase58(), role: 1 },
      { address: args.request.toBase58(), role: 1 },
      { address: args.state.addresses.redeemVaultAuthority, role: 0 },
      { address: args.state.addresses.mintConfig, role: 0 },
      { address: TOKEN_PROGRAM_ID, role: 0 },
    ],
    data: anchorNoArgsData("cancel_redeem"),
  };
}

function depositBlockingIssues(state: HastraState): { code: string; message: string }[] {
  const issues = stakeBlockingIssues(state);
  if (state.mintConfig.paused) {
    issues.unshift({
      code: "HASTRA_MINT_PAUSED",
      message: "Hastra's USDC to wYLDS mint is paused.",
    });
  }
  if (state.depositVaultFrozen) {
    issues.push({
      code: "HASTRA_DEPOSIT_VAULT_FROZEN",
      message: "Hastra's USDC deposit vault is frozen.",
    });
  }
  return issues;
}

function stakeBlockingIssues(state: HastraState): { code: string; message: string }[] {
  const issues: { code: string; message: string }[] = [];
  if (state.stakeConfig.paused) {
    issues.push({ code: "HASTRA_STAKE_PAUSED", message: "Hastra's PRIME staking pool is paused." });
  }
  if (state.stakeVaultFrozen) {
    issues.push({
      code: "HASTRA_STAKE_VAULT_FROZEN",
      message: "Hastra's wYLDS stake vault is frozen.",
    });
  }
  if (state.stakePrice.price <= 0n || state.stakePrice.timestamp <= 0n) {
    issues.push({
      code: "HASTRA_PRICE_UNAVAILABLE",
      message: "Hastra's PRIME/wYLDS redemption rate is not initialized.",
    });
  } else {
    const now = BigInt(Math.floor(Date.now() / 1_000));
    if (now - state.stakePrice.timestamp > state.stakePrice.maxStaleness) {
      issues.push({
        code: "HASTRA_PRICE_STALE",
        message: "Hastra's PRIME/wYLDS redemption rate is stale.",
      });
    }
  }
  return issues;
}

function parBlockingIssues(state: HastraState): { code: string; message: string }[] {
  const issues = stakeBlockingIssues(state);
  if (state.mintConfig.paused) {
    issues.unshift({
      code: "HASTRA_MINT_PAUSED",
      message: "Hastra's wYLDS redemption request program is paused.",
    });
  }
  if (state.redeemVaultFrozen) {
    issues.push({
      code: "HASTRA_REDEEM_VAULT_FROZEN",
      message: "Hastra's operator USDC redemption vault is frozen.",
    });
  }
  return issues;
}

function sharesForAssets(assets: bigint, price: StakePriceState): bigint {
  if (price.price <= 0n) return 0n;
  const result = (assets * price.scale) / price.price;
  if (result > U64_MAX) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      "Hastra's live rate converts this amount beyond the PRIME mint's u64 range."
    );
  }
  return result;
}

function assetsForShares(shares: bigint, price: StakePriceState): bigint {
  if (price.price <= 0n) return 0n;
  const result = (shares * price.price) / price.scale;
  if (result > U64_MAX) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      "Hastra's live rate converts this amount beyond the wYLDS mint's u64 range."
    );
  }
  return result;
}

function minimumSharesForPar(price: StakePriceState): bigint {
  if (price.price <= 0n) return 0n;
  return (HASTRA_PAR_MINIMUM_ASSET_ATOMS * price.scale + price.price - 1n) / price.price;
}

function assertNoBlockingIssues(
  issues: readonly { code: string; message: string }[],
  code: SdpHastraErrorCode,
  operation: string
): void {
  const issue = issues[0];
  if (issue) throw new SdpHastraError(code, `${operation} is unavailable: ${issue.message}`);
}

interface RedemptionRequestState {
  owner: string;
  amount: bigint;
  mint: string;
  bump: number;
}

function decodeRedemptionRequest(
  account: RpcAccount,
  config: HastraClusterConfig,
  requestAddress: string
): RedemptionRequestState {
  assertOwned(account, config.deployment.vaultMintProgramAddress, "Hastra redemption request");
  assertDiscriminator(account.data, "account", "RedemptionRequest");
  if (account.data.length < 81) {
    throw new SdpHastraError("REQUEST_UNREADABLE", "Hastra's redemption request is truncated.");
  }
  const request = {
    owner: pubkeyAt(account.data, 8, "redemption request"),
    amount: readU64(account.data, 40, "redemption request"),
    mint: pubkeyAt(account.data, 48, "redemption request"),
    bump: account.data[80] ?? -1,
  };
  const derived = redemptionRequestAddress(
    config.deployment,
    new PublicKey(request.owner)
  ).toBase58();
  if (
    derived !== requestAddress ||
    request.mint !== config.deployment.wYldsMint ||
    request.bump !==
      pda(
        new PublicKey(config.deployment.vaultMintProgramAddress),
        "redemption_request",
        new PublicKey(request.owner).toBytes()
      )[1] ||
    request.amount === 0n
  ) {
    throw new SdpHastraError(
      "REQUEST_UNREADABLE",
      "Hastra's redemption request does not match its deterministic owner, mint, or amount."
    );
  }
  return request;
}

function programEventLogs(
  logs: readonly string[] | null,
  expectedProgram: string
): readonly Buffer[] {
  if (!logs) return [];
  const stack: string[] = [];
  const data: Buffer[] = [];
  for (const log of logs) {
    const invocation = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/.exec(log);
    if (invocation) {
      const depth = Number(invocation[2]);
      if (!Number.isSafeInteger(depth) || depth < 1 || depth > stack.length + 1) {
        stack.length = 0;
        continue;
      }
      stack.length = depth - 1;
      stack.push(invocation[1] ?? "");
      continue;
    }
    const completion = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed:.*)$/.exec(log);
    if (completion) {
      if (stack.at(-1) === completion[1]) stack.pop();
      else stack.length = 0;
      continue;
    }
    if (stack.at(-1) === expectedProgram && log.startsWith("Program data: ")) {
      try {
        data.push(Buffer.from(log.slice("Program data: ".length), "base64"));
      } catch {
        // A malformed provider log is not an event.
      }
    }
  }
  return data;
}

const REQUESTED_EVENT_DISCRIMINATOR = discriminator("event", "RedemptionRequested");
const CANCELLED_EVENT_DISCRIMINATOR = discriminator("event", "RedemptionCancelled");
const FULFILLED_EVENT_DISCRIMINATOR = discriminator("event", "RedeemCompleted");

function parseParLifecycleEvents(
  config: HastraClusterConfig,
  input: EarnVaultParRedemptionLifecycleInput
): readonly EarnVaultParRedemptionLifecycleEvent[] {
  if (input.shareDecimals !== TOKEN_DECIMALS || input.assetDecimals !== TOKEN_DECIMALS) {
    throw new SdpHastraError(
      "REQUEST_UNREADABLE",
      "Hastra lifecycle events were requested with a mint scale other than six decimals."
    );
  }
  const requestedAddress = publicKey(
    "requestAddress",
    input.requestAddress,
    "REQUEST_UNREADABLE"
  ).toBase58();
  type ParsedLifecycleEvent =
    | {
        kind: "redemptionRequested" | "redemptionCancelled";
        requestAddress: string;
        owner: string;
        intermediateMint: string;
        intermediateAmount: string;
      }
    | {
        kind: "redemptionFulfilled";
        requestAddress: string;
        owner: string;
        intermediateMint: string;
        intermediateAmount: string;
        assetsPaid: string;
      };
  const decoded: ParsedLifecycleEvent[] = [];
  for (const data of programEventLogs(input.logs, config.deployment.vaultMintProgramAddress)) {
    if (data.length < 8) continue;
    const eventDiscriminator = data.subarray(0, 8);
    let kind: "redemptionRequested" | "redemptionCancelled" | "redemptionFulfilled" | null = null;
    const ownerOffset = 8;
    let amountOffset = 40;
    let mintOffset = 48;
    let vaultOffset = 80;
    if (eventDiscriminator.equals(REQUESTED_EVENT_DISCRIMINATOR)) {
      kind = "redemptionRequested";
      // RedemptionRequested names vault_token_mint before mint; the cancel
      // and completion events name mint before vault.
      mintOffset = 80;
      vaultOffset = 48;
    } else if (eventDiscriminator.equals(CANCELLED_EVENT_DISCRIMINATOR)) {
      kind = "redemptionCancelled";
    } else if (eventDiscriminator.equals(FULFILLED_EVENT_DISCRIMINATOR)) {
      kind = "redemptionFulfilled";
      amountOffset = 72; // user + admin precede amount
      mintOffset = 80;
      vaultOffset = 112;
    }
    if (!kind || data.length < vaultOffset + 32) continue;
    const owner = pubkeyAt(data, ownerOffset, `${kind} event`);
    const requestAddress = redemptionRequestAddress(
      config.deployment,
      new PublicKey(owner)
    ).toBase58();
    if (requestAddress !== requestedAddress) continue;
    const amount = readU64(data, amountOffset, `${kind} event`);
    const mint = pubkeyAt(data, mintOffset, `${kind} event`);
    const vault = pubkeyAt(data, vaultOffset, `${kind} event`);
    if (mint !== config.deployment.wYldsMint || vault !== config.depositMint || amount === 0n) {
      throw new SdpHastraError(
        "REQUEST_UNREADABLE",
        `Hastra's ${kind} event names an unexpected mint or amount.`
      );
    }
    const base = {
      requestAddress,
      owner,
      intermediateMint: mint,
      intermediateAmount: formatAtoms(amount),
    };
    if (kind === "redemptionFulfilled") {
      decoded.push({ kind, ...base, assetsPaid: formatAtoms(amount) });
    } else {
      decoded.push({ kind, ...base });
    }
  }
  if (decoded.length === 0) return [];
  if (input.blockTime === null || !/^\d+$/.test(input.blockTime)) {
    throw new SdpHastraError(
      "REQUEST_UNREADABLE",
      "A finalized Hastra lifecycle event has no trustworthy block time."
    );
  }
  const occurredAt = input.blockTime;
  return decoded.map((event): EarnVaultParRedemptionLifecycleEvent => ({ ...event, occurredAt }));
}

export class HastraVaultDirectClient
  extends HastraEarnClient
  implements
    EarnVaultDirectProvider,
    EarnVaultDepositQuoteProvider,
    EarnVaultWithdrawProvider,
    EarnVaultWithdrawQuoteProvider,
    EarnVaultParRedemptionProvider
{
  constructor(
    private readonly resolveProvenRpcUrl: (
      ctx: EarnRuntimeContext,
      cluster: SolanaCluster
    ) => Promise<string>,
    private readonly runOperation: HastraVaultOperationRunner,
    private readonly resolveSwapPort: (ctx: EarnRuntimeContext) => HastraSwapPort
  ) {
    super();
  }

  private async runtime(ctx: EarnRuntimeContext): Promise<{
    runtime: HastraRuntime;
    config: HastraClusterConfig;
  }> {
    const cluster = CLUSTER_BY_SDP_ENVIRONMENT[ctx.environment];
    const config = hastraClusterConfig(cluster);
    const rpcUrl = await this.resolveProvenRpcUrl(ctx, cluster);
    if (!rpcUrl.trim()) {
      throw new SdpHastraError(
        "POSITION_UNREADABLE",
        `No Solana RPC endpoint is configured for ${cluster}; Hastra cannot build or read.`
      );
    }
    return { runtime: { cluster, rpcUrl }, config };
  }

  private async withRuntime<T>(
    ctx: EarnRuntimeContext,
    label: string,
    operation: (
      runtime: HastraRuntime,
      config: HastraClusterConfig,
      assertActive: () => void
    ) => Promise<T>
  ): Promise<T> {
    return this.runOperation(label, async (assertActive) => {
      const { runtime, config } = await this.runtime(ctx);
      assertActive();
      return operation(runtime, config, assertActive);
    });
  }

  private assertKnownReference(config: HastraClusterConfig, providerReference: string): void {
    if (providerReference !== config.deployment.primeMint) {
      throw new SdpHastraError(
        "UNSUPPORTED_VAULT",
        `Hastra does not front ${providerReference} on ${config.cluster}; SDP's only Hastra ` +
          "strategy is PRIME."
      );
    }
  }

  sponsoredPrograms(cluster: SolanaCluster): readonly string[] {
    const deployment = hastraDeployment(cluster);
    if (!deployment) return [];
    return [
      COMPUTE_BUDGET_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      deployment.vaultMintProgramAddress,
      deployment.vaultStakeProgramAddress,
      JUPITER_AGGREGATOR_PROGRAM_ID,
    ];
  }

  async quoteVaultDeposit(
    ctx: EarnRuntimeContext,
    input: EarnVaultDepositQuoteInput
  ): Promise<EarnVaultDepositQuote> {
    const amount = canonicalAmount(input.amount, "Deposit amount");
    return this.withRuntime(ctx, "Quoting the Hastra PRIME deposit", async (runtime, config) => {
      this.assertKnownReference(config, input.providerReference);
      const state = await loadHastraState(runtime, config);
      return {
        sharesOut: formatAtoms(sharesForAssets(amount.atoms, state.stakePrice)),
        shareDecimals: TOKEN_DECIMALS,
        blockingIssues: depositBlockingIssues(state),
      };
    });
  }

  async buildVaultDeposit(
    ctx: EarnRuntimeContext,
    input: EarnVaultDepositInput
  ): Promise<EarnVaultTransactionPlan> {
    if (input.minSharesOut !== undefined) {
      throw new SdpHastraError(
        "DEPOSIT_REFUSED",
        "Hastra's v0.0.6 deposit instructions do not encode a minimum-share floor; " +
          "minSharesOut must be omitted rather than represented as protection the chain cannot enforce."
      );
    }
    const amount = canonicalAmount(input.amount, "Deposit amount");
    const owner = publicKey("owner", input.owner, "DEPOSIT_REFUSED");
    const rentPayer = publicKey("rentPayer", input.rentPayer ?? input.owner, "DEPOSIT_REFUSED");

    return this.withRuntime(
      ctx,
      "Building the Hastra USDC to PRIME deposit",
      async (runtime, config) => {
        this.assertKnownReference(config, input.providerReference);
        const state = await loadHastraState(runtime, config);
        assertNoBlockingIssues(depositBlockingIssues(state), "DEPOSIT_REFUSED", "The deposit");
        const shares = sharesForAssets(amount.atoms, state.stakePrice);
        if (shares === 0n) {
          throw new SdpHastraError(
            "INVALID_AMOUNT",
            "The deposit is too small to mint one PRIME atom at Hastra's live rate."
          );
        }

        const usdc = new PublicKey(config.depositMint);
        const wylds = new PublicKey(config.deployment.wYldsMint);
        const prime = new PublicKey(config.deployment.primeMint);
        const userUsdc = associatedTokenAddress(owner, usdc);
        const userWylds = associatedTokenAddress(owner, wylds);
        const userPrime = associatedTokenAddress(owner, prime);
        const [userUsdcAccount, userWyldsAccount, userPrimeAccount] = await getMultipleAccounts(
          runtime,
          [userUsdc.toBase58(), userWylds.toBase58(), userPrime.toBase58()]
        );
        assertOwnerTokenUsable(
          userUsdcAccount ?? null,
          "Owner USDC token account",
          config.depositMint,
          owner.toBase58(),
          "DEPOSIT_REFUSED",
          amount.atoms
        );
        assertExistingOwnerTokenUsable(
          userWyldsAccount ?? null,
          "Owner wYLDS token account",
          config.deployment.wYldsMint,
          owner.toBase58(),
          "DEPOSIT_REFUSED"
        );
        assertExistingOwnerTokenUsable(
          userPrimeAccount ?? null,
          "Owner PRIME token account",
          config.deployment.primeMint,
          owner.toBase58(),
          "DEPOSIT_REFUSED"
        );
        const shareAccountExisted = userPrimeAccount !== null;

        return {
          cluster: runtime.cluster,
          instructions: [
            computeUnitLimitInstruction(HASTRA_NATIVE_COMPUTE_UNIT_LIMIT),
            createAssociatedTokenInstruction(rentPayer, owner, wylds),
            createAssociatedTokenInstruction(rentPayer, owner, prime),
            mintDepositInstruction({
              config,
              state,
              owner,
              userUsdc,
              userWylds,
              amount: amount.atoms,
            }),
            stakeDepositInstruction({
              config,
              state,
              owner,
              userWylds,
              userPrime,
              amount: amount.atoms,
            }),
          ],
          lookupTables: [],
          assetIdentity: { depositTokenMint: config.depositMint, shareMint: prime.toBase58() },
          accepted: { amount: amount.text },
          createsShareAccount: !shareAccountExisted,
        };
      }
    );
  }

  async quoteVaultWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnVaultWithdrawQuoteInput
  ): Promise<EarnVaultWithdrawQuote> {
    const shares = canonicalAmount(input.shares, "Share amount");
    const swapPort = this.resolveSwapPort(ctx);
    return this.withRuntime(ctx, "Quoting the Hastra PRIME DEX exit", async (runtime, config) => {
      this.assertKnownReference(config, input.providerReference);
      const state = await loadHastraState(runtime, config);
      const issues = stakeBlockingIssues(state);
      const wylds = assetsForShares(shares.atoms, state.stakePrice);
      if (wylds === 0n) {
        return { assetsOut: "0", assetDecimals: TOKEN_DECIMALS, blockingIssues: issues };
      }
      let quote: { outAmount: string };
      let assetsOut: string;
      try {
        quote = await swapPort.quoteSwap({
          cluster: runtime.cluster,
          inputMint: config.deployment.wYldsMint,
          outputMint: config.depositMint,
          amount: formatAtoms(wylds),
        });
        assetsOut = canonicalAmount(quote.outAmount, "Jupiter quoted output").text;
      } catch (cause) {
        throw new SdpHastraError("SWAP_UNAVAILABLE", "Jupiter could not quote wYLDS to USDC.", {
          cause,
        });
      }
      return {
        assetsOut,
        assetDecimals: TOKEN_DECIMALS,
        blockingIssues: issues,
      };
    });
  }

  async buildVaultWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnVaultWithdrawInput
  ): Promise<EarnVaultTransactionPlan> {
    if (input.minAmountOut === undefined) {
      throw new SdpHastraError(
        "INVALID_AMOUNT",
        "Hastra DEX exits require minAmountOut; SDP will not choose market slippage for the caller."
      );
    }
    const shares = canonicalAmount(input.shares, "Share amount");
    const floor = canonicalAmount(input.minAmountOut, "minAmountOut");
    const owner = publicKey("owner", input.owner, "WITHDRAW_REFUSED");
    const rentPayer = publicKey("rentPayer", input.rentPayer ?? input.owner, "WITHDRAW_REFUSED");
    const rentRefundTo = publicKey(
      "rentRefundTo",
      input.rentRefundTo ?? input.owner,
      "WITHDRAW_REFUSED"
    );
    const swapPort = this.resolveSwapPort(ctx);

    return this.withRuntime(
      ctx,
      "Building the Hastra PRIME DEX exit",
      async (runtime, config, assertActive) => {
        this.assertKnownReference(config, input.providerReference);
        const state = await loadHastraState(runtime, config);
        assertNoBlockingIssues(stakeBlockingIssues(state), "WITHDRAW_REFUSED", "The DEX exit");
        const wyldsAtoms = assetsForShares(shares.atoms, state.stakePrice);
        if (wyldsAtoms === 0n) {
          throw new SdpHastraError(
            "INVALID_AMOUNT",
            "The withdrawal is too small to redeem one wYLDS atom at Hastra's live rate."
          );
        }
        if (state.stakeVaultLiquidity < wyldsAtoms) {
          throw new SdpHastraError(
            "WITHDRAW_REFUSED",
            "Hastra's PRIME vault does not currently hold enough wYLDS for this redemption."
          );
        }

        const wylds = new PublicKey(config.deployment.wYldsMint);
        const prime = new PublicKey(config.deployment.primeMint);
        const usdc = new PublicKey(config.depositMint);
        const userWylds = associatedTokenAddress(owner, wylds);
        const userPrime = associatedTokenAddress(owner, prime);
        const userUsdc = associatedTokenAddress(owner, usdc);
        const [userWyldsAccount, userPrimeAccount, userUsdcAccount] = await getMultipleAccounts(
          runtime,
          [userWylds.toBase58(), userPrime.toBase58(), userUsdc.toBase58()]
        );
        assertOwnerTokenUsable(
          userPrimeAccount ?? null,
          "Owner PRIME token account",
          config.deployment.primeMint,
          owner.toBase58(),
          "WITHDRAW_REFUSED",
          shares.atoms
        );
        assertExistingOwnerTokenUsable(
          userWyldsAccount ?? null,
          "Owner wYLDS token account",
          config.deployment.wYldsMint,
          owner.toBase58(),
          "WITHDRAW_REFUSED"
        );
        assertExistingOwnerTokenUsable(
          userUsdcAccount ?? null,
          "Owner USDC token account",
          config.depositMint,
          owner.toBase58(),
          "WITHDRAW_REFUSED"
        );
        const legacyTicket = await readLegacyTicket(runtime, config, owner);
        if (
          legacyTicket &&
          input.rentRefundTo !== undefined &&
          input.rentRefundTo !== input.owner
        ) {
          throw new SdpHastraError(
            "WITHDRAW_REFUSED",
            "This wallet has a legacy Hastra ticket whose program-hardcoded rent refund goes to " +
              "the owner, not the requested rentRefundTo address."
          );
        }
        const transientWylds = await transientTokenAccountPlan({
          runtime,
          payer: rentPayer,
          owner,
          mint: wylds,
          destination: userWylds,
          refundTo: rentRefundTo,
          amount: wyldsAtoms,
        });
        const leg = await this.buildLegWithFloor({
          swapPort,
          runtime,
          config,
          amount: { atoms: wyldsAtoms, text: formatAtoms(wyldsAtoms) },
          floor,
          owner: owner.toBase58(),
          payer: rentPayer.toBase58(),
          assertActive,
        });

        return {
          cluster: runtime.cluster,
          instructions: [
            computeUnitLimitInstruction(HASTRA_SWAP_COMPUTE_UNIT_LIMIT),
            createAssociatedTokenInstruction(rentPayer, owner, wylds),
            createAssociatedTokenInstruction(rentPayer, owner, usdc),
            ...transientWylds.setupInstructions,
            stakeRedeemInstruction({
              config,
              state,
              owner,
              userWylds: transientWylds.address,
              userPrime,
              legacyTicket,
              amount: shares.atoms,
            }),
            ...transientWylds.settleInstructions,
            ...leg.instructions,
          ],
          lookupTables: [...new Set(leg.lookupTableAddresses)],
          assetIdentity: {
            depositTokenMint: config.depositMint,
            shareMint: config.deployment.primeMint,
          },
          accepted: { shares: shares.text, minAmountOut: floor.text },
        };
      }
    );
  }

  private async buildLegWithFloor(args: {
    swapPort: HastraSwapPort;
    runtime: HastraRuntime;
    config: HastraClusterConfig;
    amount: { text: string; atoms: bigint };
    floor: { text: string; atoms: bigint };
    owner: string;
    payer: string;
    assertActive: () => void;
  }): Promise<HastraSwapLeg> {
    const quote = await args.swapPort.quoteSwap({
      cluster: args.runtime.cluster,
      inputMint: args.config.deployment.wYldsMint,
      outputMint: args.config.depositMint,
      amount: args.amount.text,
    });
    let quoteAtoms: bigint;
    try {
      quoteAtoms = canonicalAmount(quote.outAmount, "Jupiter quoted output").atoms;
    } catch (cause) {
      throw new SdpHastraError("SWAP_UNAVAILABLE", "Jupiter returned an invalid wYLDS quote.", {
        cause,
      });
    }
    if (quoteAtoms < args.floor.atoms) {
      throw new SdpHastraError(
        "WITHDRAW_REFUSED",
        `The wYLDS market pays ${quote.outAmount} USDC, below the requested ${args.floor.text} floor.`
      );
    }
    let slippageBps = Number(((quoteAtoms - args.floor.atoms) * 10_000n) / quoteAtoms);
    slippageBps = Math.min(slippageBps, 9_999);

    for (;;) {
      args.assertActive();
      const leg = await args.swapPort.buildSwapLeg({
        cluster: args.runtime.cluster,
        inputMint: args.config.deployment.wYldsMint,
        outputMint: args.config.depositMint,
        amount: args.amount.text,
        owner: args.owner,
        payer: args.payer,
        slippageBps,
        maxAccounts: HASTRA_JUPITER_MAX_ACCOUNTS,
      });
      if (leg.instructions.length === 0) {
        throw new SdpHastraError(
          "SWAP_UNAVAILABLE",
          "Jupiter returned no executable instructions for the wYLDS exit."
        );
      }
      let thresholdAtoms: bigint;
      try {
        thresholdAtoms = canonicalAmount(leg.minOutAmount, "Jupiter guaranteed output").atoms;
      } catch (cause) {
        throw new SdpHastraError(
          "SWAP_UNAVAILABLE",
          "Jupiter returned an invalid guaranteed output.",
          { cause }
        );
      }
      if (thresholdAtoms >= args.floor.atoms) return leg;
      if (slippageBps === 0) {
        throw new SdpHastraError(
          "WITHDRAW_REFUSED",
          `Jupiter's guaranteed output ${leg.minOutAmount} is below the requested ` +
            `${args.floor.text} floor even at zero tolerance.`
        );
      }
      slippageBps = 0;
    }
  }

  async readVaultPositions(
    ctx: EarnRuntimeContext,
    input: EarnVaultPositionInput
  ): Promise<EarnVaultPositionSnapshot[]> {
    const owner = publicKey("owner", input.owner, "POSITION_UNREADABLE");
    return this.withRuntime(ctx, "Reading Hastra PRIME positions", async (runtime, config) => {
      const readAll = input.providerReferences.length === 0;
      const references = readAll ? [config.deployment.primeMint] : input.providerReferences;
      for (const reference of references) this.assertKnownReference(config, reference);
      if (references.length === 0) return [];

      const state = await loadHastraState(runtime, config);
      const primeAccount = associatedTokenAddress(
        owner,
        new PublicKey(config.deployment.primeMint)
      );
      const account = await getAccount(runtime, primeAccount.toBase58(), "POSITION_UNREADABLE");
      const tokenAccount = account
        ? decodeTokenAccount(
            account,
            "Owner PRIME token account",
            config.deployment.primeMint,
            owner.toBase58()
          )
        : { amount: 0n, frozen: false };
      const atoms = tokenAccount.amount;
      if (readAll && atoms === 0n) return [];
      const shares = formatAtoms(atoms);
      const parValue = formatAtoms(assetsForShares(atoms, state.stakePrice));
      return [
        {
          providerReference: config.deployment.primeMint,
          owner: owner.toBase58(),
          cluster: runtime.cluster,
          shares,
          // Hastra exposes freeze administration on PRIME. Frozen tokens stay
          // the owner's holding but the token program will reject a burn.
          withdrawableShares: tokenAccount.frozen ? "0" : shares,
          tokenValue: parValue,
          tokenMint: config.depositMint,
          shareMint: config.deployment.primeMint,
        },
      ];
    });
  }

  async getParRedemptionOptions(
    ctx: EarnRuntimeContext,
    input: EarnVaultWithdrawalOptionsInput
  ): Promise<EarnVaultParRedemptionOptions> {
    return this.withRuntime(
      ctx,
      "Reading Hastra par-redemption options",
      async (runtime, config) => {
        this.assertKnownReference(config, input.providerReference);
        const state = await loadHastraState(runtime, config);
        if (state.stakePrice.price <= 0n) {
          throw new SdpHastraError(
            "REDEMPTION_REFUSED",
            "Hastra's rate is unavailable, so its live PRIME minimum cannot be calculated."
          );
        }
        return {
          intermediateMint: config.deployment.wYldsMint,
          assetMint: config.depositMint,
          minimumShares: formatAtoms(minimumSharesForPar(state.stakePrice)),
          shareDecimals: TOKEN_DECIMALS,
          assetDecimals: TOKEN_DECIMALS,
          cancelable: true,
          operatorSettled: true,
        };
      }
    );
  }

  async quoteParRedemption(
    ctx: EarnRuntimeContext,
    input: EarnVaultParRedemptionQuoteInput
  ): Promise<EarnVaultParRedemptionQuote> {
    const shares = canonicalAmount(input.shares, "Share amount");
    return this.withRuntime(ctx, "Quoting the Hastra par redemption", async (runtime, config) => {
      this.assertKnownReference(config, input.providerReference);
      const state = await loadHastraState(runtime, config);
      const intermediate = assetsForShares(shares.atoms, state.stakePrice);
      const blockingIssues = parBlockingIssues(state);
      if (intermediate === 0n) {
        blockingIssues.push({
          code: "HASTRA_REDEMPTION_DUST",
          message: "The request is too small to redeem one wYLDS atom at Hastra's live rate.",
        });
      }
      return {
        shares: shares.text,
        shareDecimals: TOKEN_DECIMALS,
        intermediateMint: config.deployment.wYldsMint,
        intermediateAmount: formatAtoms(intermediate),
        assetMint: config.depositMint,
        assets: formatAtoms(intermediate),
        assetDecimals: TOKEN_DECIMALS,
        blockingIssues,
      };
    });
  }

  async buildParRedemptionRequest(
    ctx: EarnRuntimeContext,
    input: EarnVaultParRedemptionRequestInput
  ): Promise<EarnVaultParRedemptionRequestPlan> {
    if (input.rentPayer !== undefined && input.rentPayer !== input.owner) {
      throw new SdpHastraError(
        "REDEMPTION_REFUSED",
        "Hastra's request instruction hardcodes the owner as both request rent payer and rent " +
          "refund recipient; a different rentPayer cannot be represented honestly."
      );
    }
    const owner = publicKey("owner", input.owner, "REDEMPTION_REFUSED");
    const shares = canonicalAmount(input.shares, "Share amount");
    return this.withRuntime(
      ctx,
      "Building the Hastra par-redemption request",
      async (runtime, config) => {
        this.assertKnownReference(config, input.providerReference);
        const state = await loadHastraState(runtime, config);
        assertNoBlockingIssues(
          parBlockingIssues(state),
          "REDEMPTION_REFUSED",
          "The par-redemption request"
        );
        const intermediateAtoms = assetsForShares(shares.atoms, state.stakePrice);
        if (intermediateAtoms < HASTRA_PAR_MINIMUM_ASSET_ATOMS) {
          throw new SdpHastraError(
            "REDEMPTION_REFUSED",
            "The request is too small to redeem one wYLDS atom at Hastra's live rate."
          );
        }
        if (state.stakeVaultLiquidity < intermediateAtoms) {
          throw new SdpHastraError(
            "REDEMPTION_REFUSED",
            "Hastra's PRIME vault does not currently hold enough wYLDS for this request."
          );
        }

        const request = redemptionRequestAddress(config.deployment, owner);
        if ((await getAccount(runtime, request.toBase58(), "REQUEST_UNREADABLE")) !== null) {
          throw new SdpHastraError(
            "REDEMPTION_REFUSED",
            "This wallet already has an open Hastra redemption request; complete or cancel it first."
          );
        }
        await assertRedemptionRequestReuseSafe(runtime, config, request.toBase58());
        const wylds = new PublicKey(config.deployment.wYldsMint);
        const prime = new PublicKey(config.deployment.primeMint);
        const usdc = new PublicKey(config.depositMint);
        const userWylds = associatedTokenAddress(owner, wylds);
        const userPrime = associatedTokenAddress(owner, prime);
        const userUsdc = associatedTokenAddress(owner, usdc);
        const [userWyldsAccount, userPrimeAccount, userUsdcAccount] = await getMultipleAccounts(
          runtime,
          [userWylds.toBase58(), userPrime.toBase58(), userUsdc.toBase58()]
        );
        assertOwnerTokenUsable(
          userPrimeAccount ?? null,
          "Owner PRIME token account",
          config.deployment.primeMint,
          owner.toBase58(),
          "REDEMPTION_REFUSED",
          shares.atoms
        );
        assertExistingOwnerTokenUsable(
          userWyldsAccount ?? null,
          "Owner wYLDS token account",
          config.deployment.wYldsMint,
          owner.toBase58(),
          "REDEMPTION_REFUSED"
        );
        assertExistingOwnerTokenUsable(
          userUsdcAccount ?? null,
          "Owner USDC token account",
          config.depositMint,
          owner.toBase58(),
          "REDEMPTION_REFUSED"
        );
        const legacyTicket = await readLegacyTicket(runtime, config, owner);
        const intermediate = formatAtoms(intermediateAtoms);
        const transientWylds = await transientTokenAccountPlan({
          runtime,
          payer: owner,
          owner,
          mint: wylds,
          destination: userWylds,
          refundTo: owner,
          amount: intermediateAtoms,
        });

        return {
          cluster: runtime.cluster,
          instructions: [
            computeUnitLimitInstruction(HASTRA_NATIVE_COMPUTE_UNIT_LIMIT),
            createAssociatedTokenInstruction(owner, owner, wylds),
            // Completion is operator-signed, so prepare the user's canonical USDC destination now.
            createAssociatedTokenInstruction(owner, owner, usdc),
            ...transientWylds.setupInstructions,
            stakeRedeemInstruction({
              config,
              state,
              owner,
              userWylds: transientWylds.address,
              userPrime,
              legacyTicket,
              amount: shares.atoms,
            }),
            ...transientWylds.settleInstructions,
            parRequestInstruction({
              config,
              state,
              owner,
              userWylds,
              request,
              amount: intermediateAtoms,
            }),
          ],
          lookupTables: [],
          assetIdentity: {
            depositTokenMint: config.depositMint,
            shareMint: config.deployment.primeMint,
          },
          accepted: { shares: shares.text },
          requestAddress: request.toBase58(),
          expectedRequest: {
            shares: shares.text,
            intermediateMint: config.deployment.wYldsMint,
            intermediateAmount: intermediate,
            assetMint: config.depositMint,
            assets: intermediate,
          },
        };
      }
    );
  }

  async buildParRedemptionCancel(
    ctx: EarnRuntimeContext,
    input: EarnVaultParRedemptionCancelInput
  ): Promise<EarnVaultTransactionPlan> {
    const owner = publicKey("owner", input.owner, "REDEMPTION_REFUSED");
    const request = publicKey("requestAddress", input.requestAddress, "REDEMPTION_REFUSED");
    return this.withRuntime(
      ctx,
      "Building the Hastra redemption cancel",
      async (runtime, config) => {
        this.assertKnownReference(config, input.providerReference);
        const expected = redemptionRequestAddress(config.deployment, owner);
        if (!request.equals(expected)) {
          throw new SdpHastraError(
            "REDEMPTION_REFUSED",
            "The Hastra request address is not the deterministic request for this owner."
          );
        }
        const [state, account] = await Promise.all([
          loadHastraState(runtime, config),
          getAccount(runtime, request.toBase58(), "REQUEST_UNREADABLE"),
        ]);
        if (!account) {
          throw new SdpHastraError("REDEMPTION_REFUSED", "The Hastra request is already closed.");
        }
        const decoded = decodeRedemptionRequest(account, config, request.toBase58());
        if (decoded.owner !== owner.toBase58()) {
          throw new SdpHastraError(
            "REDEMPTION_REFUSED",
            "The Hastra request belongs to another owner."
          );
        }
        const wylds = new PublicKey(config.deployment.wYldsMint);
        const userWylds = associatedTokenAddress(owner, wylds);
        assertExistingOwnerTokenUsable(
          await getAccount(runtime, userWylds.toBase58(), "REQUEST_UNREADABLE"),
          "Owner wYLDS token account",
          config.deployment.wYldsMint,
          owner.toBase58(),
          "REDEMPTION_REFUSED"
        );
        return {
          cluster: runtime.cluster,
          instructions: [
            createAssociatedTokenInstruction(owner, owner, wylds),
            parCancelInstruction({ config, state, owner, userWylds, request }),
          ],
          lookupTables: [],
          assetIdentity: {
            depositTokenMint: config.depositMint,
            shareMint: config.deployment.primeMint,
          },
        };
      }
    );
  }

  async readParRedemptionRequest(
    ctx: EarnRuntimeContext,
    input: EarnVaultParRedemptionRequestReadInput
  ): Promise<EarnVaultParRedemptionRequestLookup> {
    const requestAddress = publicKey(
      "requestAddress",
      input.requestAddress,
      "REQUEST_UNREADABLE"
    ).toBase58();
    return this.withRuntime(
      ctx,
      "Reading the Hastra redemption request",
      async (runtime, config) => {
        this.assertKnownReference(config, input.providerReference);
        await loadHastraState(runtime, config);
        const account = await getAccount(runtime, requestAddress, "REQUEST_UNREADABLE");
        if (!account) return { requestAddress, status: "closedOrUnknown", request: null };
        const decoded = decodeRedemptionRequest(account, config, requestAddress);
        return {
          requestAddress,
          status: "pending",
          request: {
            requestAddress,
            providerReference: config.deployment.primeMint,
            owner: decoded.owner,
            intermediateMint: decoded.mint,
            intermediateAmount: formatAtoms(decoded.amount),
          },
        };
      }
    );
  }

  async decodeParRedemptionLifecycleEvents(
    ctx: EarnRuntimeContext,
    input: EarnVaultParRedemptionLifecycleInput
  ): Promise<readonly EarnVaultParRedemptionLifecycleEvent[]> {
    const cluster = CLUSTER_BY_SDP_ENVIRONMENT[ctx.environment];
    const config = hastraClusterConfig(cluster);
    this.assertKnownReference(config, input.providerReference);
    return parseParLifecycleEvents(config, input);
  }
}

/** A direct token vault must never be mistaken for a provider-custodied wallet. */
export function assertNotPortfolioProvider(client: HastraVaultDirectClient): void {
  if (supportsPortfolioWallets(client)) {
    throw new SdpHastraError(
      "UNSUPPORTED_VAULT",
      "Hastra must never report the portfolio-wallet capability: its program addresses and " +
        "token mints are not fundable customer deposit addresses."
    );
  }
}
