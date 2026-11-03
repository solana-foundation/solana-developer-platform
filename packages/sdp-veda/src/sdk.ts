import { AsyncLocalStorage } from "node:async_hooks";
import { decodeAssetData } from "@sdp/earn/providers/veda/vault-state";
import { EARN_QUEUED_WITHDRAWAL_MAXIMUM_DEADLINE_SECONDS } from "@sdp/types/earn";
import { isVedaDepositMint } from "@sdp/types/veda-programs";
import {
  type Address,
  address,
  fetchEncodedAccounts,
  type Instruction,
  type MaybeEncodedAccount,
} from "@solana/kit";
import {
  createVedaClient,
  findAllowedUserPda,
  findAssetDataPda,
  findExtraAccountMetasPda,
  findHookConfigPda,
  findPermissionPda,
  findQueuePda,
  findQueueStatePda,
  findQueueWithdrawAssetPda,
  findUserWithdrawStatePda,
  parseLifecycleEvents,
  VedaSdkError,
} from "@vedatech/svm-sdk";
import { z } from "zod";
import { accountExists, minimumBalanceForRentExemption } from "./accounts";
import {
  allowedUserAccountForDeposit,
  prefundOwnerRentInstruction,
  VEDA_ALLOWED_USER_ACCOUNT_SIZE,
} from "./allowed-user";
import { type AcceptedAmount, acceptPositiveAtMintScale, mintDecimals } from "./amounts";
import { SdpVedaError, vaultUnreadable } from "./errors";
import { assertPlanTargetsCluster } from "./guards";
import { readMintDecimals } from "./mint";
import { type VedaClusterConfig, vedaShareAccountAddress } from "./programs";
import {
  queuedWithdrawalOwnerFundedAccountSizes,
  queuedWithdrawalRequestAddress,
} from "./queue-rent";
import { chargeAtaCreationRentTo, createdAtaAddressForMint } from "./rent";
import { createVedaReadRpc, createVedaRpc } from "./rpc";
import type {
  VedaDepositInput,
  VedaDepositQuote,
  VedaDepositQuoteInput,
  VedaInstructionPlan,
  VedaPosition,
  VedaPositionInput,
  VedaQueuedWithdrawalCancelInput,
  VedaQueuedWithdrawalQuote,
  VedaQueuedWithdrawalQuoteInput,
  VedaQueuedWithdrawalRequest,
  VedaQueuedWithdrawalRequestInput,
  VedaQueuedWithdrawalRequestInputByAddress,
  VedaQueuedWithdrawalRequestLookup,
  VedaQueuedWithdrawalRequestPlan,
  VedaQueuedWithdrawalRequestsInput,
  VedaRuntime,
  VedaWithdrawalLifecycleEvent,
  VedaWithdrawalLifecycleScales,
  VedaWithdrawalOptions,
  VedaWithdrawalOptionsInput,
  VedaWithdrawInput,
  VedaWithdrawQuote,
  VedaWithdrawQuoteInput,
} from "./types";

/**
 * ════════════════════════════════════════════════════════════════════════════
 *  THE KIT-VERSION FIREWALL. This is the ONLY module in the package — source or
 *  test — that may import `@vedatech/svm-sdk`.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The SDK is built against `@solana/kit` **7.0.0**; this repo's catalog pins
 * **7.1.1**, and pnpm nests the SDK's own copy, so both live in the tree
 * (alongside the 2.3.0 klend-sdk drags in and mosaic-sdk's 6.10.0). Every cast
 * below is a STRUCTURAL re-label across that seam, not a coercion: kit's
 * `Instruction` is a plain object with `programAddress`, a numeric
 * `AccountRole` and `Uint8Array` data in both copies, and nothing kit-typed
 * crosses this module's exports — see `./types.ts`.
 *
 * Keeping the SDK behind one module is also what keeps it out of `@sdp/earn`,
 * whose catalogue cron runs hourly in both environments and never builds a
 * transaction.
 */

/** The SDK's kit-7 surface, as far as this module needs to name it. */
// biome-ignore lint/suspicious/noExplicitAny: the kit-7 <-> kit-6.8 seam; see the header.
type Kit7 = any;

/**
 * How long a compatibility verdict is trusted.
 *
 * Not process-lifetime. A deployment's structure is stable, but a URL is not:
 * DNS, a load balancer or a config change can repoint the same endpoint at a
 * different cluster, and this verdict is a funds authorization. A short window
 * keeps a burst of deposits from re-validating on every call without turning
 * one old observation into a standing permission. Same reasoning as the API's
 * `CLUSTER_ENDPOINT_PROOF_TTL_MS`, with a longer window because the check is
 * heavier and the property it proves is structural.
 */
export const VEDA_COMPATIBILITY_TTL_MS = 600_000;

interface CompatibilityEntry {
  promise: Promise<void>;
  /** Null while the shared probe is still in flight. */
  expiresAt: number | null;
}

const compatibility = new Map<string, CompatibilityEntry>();

/** Test seam: forget cached compatibility verdicts. */
export function resetVedaCompatibilityCache(): void {
  compatibility.clear();
}

function client(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  commitment: "confirmed" | "finalized" = "confirmed",
  // The transport deadline covers both our direct reads and every nested vault,
  // asset, oracle and mint request the SDK performs with this same client.
  rpc: Kit7 = createVedaRpc(runtime.rpcUrl)
) {
  return createVedaClient({
    rpc,
    deployment: {
      vaultProgramAddress: config.vaultProgramAddress as Kit7,
      ...(config.queueProgramAddress === undefined
        ? {}
        : { queueProgramAddress: config.queueProgramAddress as Kit7 }),
      hookProgramAddress: config.hookProgramAddress as Kit7,
      label: `sdp-${config.cluster}`,
    },
    commitment,
  });
}

/**
 * How long position reads, deposits, exits and the queue lifecycle trust a
 * shared SDK client and a vault's static facts (share mint, share decimals,
 * vault id, the fronted asset's mint and its decimals). Only the deposit
 * compatibility verdict keeps its own client and cache. Same window as that
 * verdict, for the same reason: a URL can be repointed.
 */
export const VEDA_READ_CACHE_TTL_MS = VEDA_COMPATIBILITY_TTL_MS;

interface CachedRead<T> {
  promise: Promise<T>;
  /** Null while the shared read is still in flight. */
  expiresAt: number | null;
}

interface VaultShareFacts {
  shareMint: Address;
  shareDecimals: unknown;
  /**
   * Fixed by the vault's address: the SDK refuses a vault state that is not
   * the program's PDA for its own vault id.
   */
  vaultId: bigint;
}

/** The identity fields of an SDK `getState()` answer, parsed where they cross the seam. */
const vaultIdentitySchema = z.object({ shareMint: z.string(), vaultId: z.bigint() });

/** A vault's static facts from an SDK `getState()` answer. */
function vaultShareFactsOf(state: Kit7): VaultShareFacts {
  const identity = vaultIdentitySchema.parse(state);
  return {
    shareMint: address(identity.shareMint),
    shareDecimals: state.shareDecimals,
    vaultId: identity.vaultId,
  };
}

/**
 * Runs a SHARED fill in the async context captured at module load, outside any
 * caller's. The memoised facts are static, so no caller's minimum-slot read
 * scope (`withMinimumRpcSlot`) applies to them, and one scoped caller's
 * slot-lag failure must not fail an unscoped caller that joined the same fill.
 * Each caller's live holding and quote reads still run in its own scope.
 */
const outsideCallerScopes = AsyncLocalStorage.snapshot();

/** A shared SDK client, the RPC handle it reads through and its commitment. */
interface SharedClient {
  veda: Kit7;
  rpc: ReturnType<typeof createVedaReadRpc>;
  commitment: "confirmed" | "finalized";
  expiresAt: number;
}

const sharedClients = new Map<string, SharedClient>();
const vaultShareFacts = new Map<string, CachedRead<VaultShareFacts>>();
const vaultAssetMints = new Map<string, CachedRead<Address>>();
const assetMintDecimals = new Map<string, CachedRead<number>>();

/** Most shared clients kept at once, one per (cluster, endpoint, commitment, deployment). */
const VEDA_READ_CLIENT_CAPACITY = 32;
/** Most entries kept in each facts cache, one per (cluster, endpoint, vault or mint). */
const VEDA_READ_FACTS_CAPACITY = 256;

/** Test seam: forget the shared clients and memoised vault and mint facts. */
export function resetVedaReadCaches(): void {
  sharedClients.clear();
  vaultShareFacts.clear();
  vaultAssetMints.clear();
  assetMintDecimals.clear();
}

/** Test seam: how many entries each shared cache holds. */
export function vedaReadCacheSizes(): {
  clients: number;
  shareFacts: number;
  assetMints: number;
  mintDecimals: number;
} {
  return {
    clients: sharedClients.size,
    shareFacts: vaultShareFacts.size,
    assetMints: vaultAssetMints.size,
    mintDecimals: assetMintDecimals.size,
  };
}

/**
 * Store `value` as the newest entry for `key`, after dropping every expired
 * entry and then the oldest past `capacity`, so distinct endpoints and vaults
 * cannot grow a cache for the process's lifetime.
 */
function storeBounded<V extends { expiresAt: number | null }>(
  cache: Map<string, V>,
  key: string,
  value: V,
  capacity: number
): void {
  const now = Date.now();
  for (const [stored, entry] of cache) {
    if (entry.expiresAt !== null && entry.expiresAt <= now) cache.delete(stored);
  }
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > capacity) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * One SDK client per (cluster, endpoint, commitment, deployment) for every
 * read, quote and build except the deposit compatibility check
 * (`assertVedaVaultUsable`), which keeps a client of its own.
 *
 * The SDK validates all three programs in its CONSTRUCTOR (six requests) and
 * memoises that verdict per instance, so a client per call paid them every
 * time. Sharing one client also shares its de-duplicating transport
 * (`createVedaReadRpc`) across concurrent callers. The commitment is the
 * client's, fixed at construction, so durable finalized reads get a client of
 * their own. The SDK keeps a rejected validation forever, so a client whose
 * validation rejects is evicted at once; the calls that observed it fail
 * exactly as they did before.
 */
function sharedClient(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  commitment: "confirmed" | "finalized" = "confirmed"
): SharedClient {
  const key = [
    config.cluster,
    runtime.rpcUrl,
    commitment,
    config.vaultProgramAddress,
    config.hookProgramAddress,
    config.queueProgramAddress ?? "",
  ].join("\n");
  const cached = sharedClients.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;

  // The constructor fires the program validations, so it runs unscoped too.
  const entry = outsideCallerScopes((): SharedClient => {
    const rpc = createVedaReadRpc(runtime.rpcUrl);
    return {
      veda: client(runtime, config, commitment, rpc),
      rpc,
      commitment,
      expiresAt: Date.now() + VEDA_READ_CACHE_TTL_MS,
    };
  });
  storeBounded(sharedClients, key, entry, VEDA_READ_CLIENT_CAPACITY);
  void Promise.resolve()
    .then(() => entry.veda.validateDeployment())
    .catch(() => {
      if (sharedClients.get(key) === entry) sharedClients.delete(key);
    });
  return entry;
}

function vaultFactsKey(runtime: VedaRuntime, config: VedaClusterConfig, vault: Address): string {
  return [config.cluster, runtime.rpcUrl, config.vaultProgramAddress, vault].join("\n");
}

/** Shared in-flight, kept for the TTL on success, never kept on failure. */
async function cachedRead<T>(
  cache: Map<string, CachedRead<T>>,
  key: string,
  load: () => Promise<T>
): Promise<T> {
  let entry = cache.get(key);
  if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
    cache.delete(key);
    entry = undefined;
  }
  if (!entry) {
    entry = { promise: outsideCallerScopes(load), expiresAt: null };
    storeBounded(cache, key, entry, VEDA_READ_FACTS_CAPACITY);
  }
  const current = entry;
  try {
    const value = await current.promise;
    if (cache.get(key) === current && current.expiresAt === null) {
      current.expiresAt = Date.now() + VEDA_READ_CACHE_TTL_MS;
    }
    return value;
  } catch (cause) {
    if (cache.get(key) === current) cache.delete(key);
    throw cause;
  }
}

/** The vault's share mint, share decimals and id, read once per cache window. */
function cachedShareFacts(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  vaultClient: Kit7,
  vault: Address
): Promise<VaultShareFacts> {
  // No instruction rewrites the share mint after deploy, a mint's decimals
  // never change, and the vault id is fixed by the vault's address. Position
  // reads re-check the share mint against the live share account.
  return cachedRead(vaultShareFacts, vaultFactsKey(runtime, config, vault), async () =>
    vaultShareFactsOf(await vaultClient.getState())
  );
}

/** The asset SDP fronts, resolved by identity (`resolveVaultAssetMint`) once per window. */
function cachedAssetMint(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  vaultClient: Kit7,
  vault: Address
): Promise<Address> {
  return cachedRead(vaultAssetMints, vaultFactsKey(runtime, config, vault), () =>
    resolveVaultAssetMint(config, vaultClient, vault)
  );
}

/** A mint's own decimals (`readMintDecimals`), which no instruction can change. */
function cachedMintDecimals(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  mint: Address
): Promise<number> {
  return cachedRead(assetMintDecimals, [config.cluster, runtime.rpcUrl, mint].join("\n"), () =>
    readMintDecimals(runtime.rpcUrl, mint)
  );
}

async function holdsShareAccount(
  owner: Address,
  shareMint: Kit7,
  shareAccount: Kit7
): Promise<boolean> {
  const expected = await vedaShareAccountAddress(owner, address(String(shareMint)));
  return String(expected) === String(shareAccount);
}

/**
 * Prove the live deployment is the one SDP thinks it is, before building
 * anything against it.
 *
 * `validateDeployment()` checks that each configured program exists, is
 * executable and uses the expected upgradeable loader.
 * `validateCompatibility()` additionally re-derives the vault's own PDAs — the
 * share mint, the transfer hook's config and extra-account-metas, the queue's
 * ownership and its immutable Token-2022 share account — and refuses if any of
 * them does not belong to the vault at hand.
 *
 * **`requireQueue: true`, on the DEPOSIT path.** That looks like the wrong
 * capability to demand until you read it as ADR 0002's exit-safety rule: the
 * queue is Veda's durable way out, and SDP will not open a position in a vault
 * whose exit infrastructure is not configured and wired to the vault. It gates
 * only the way IN — the catalogue read, position reads and any future exit path
 * never call this — so it can never trap funds, only decline to create them.
 *
 * Verdicts are cached per (cluster, endpoint, vault) for a short window.
 * FAILURES ARE NEVER CACHED: an incompatible or unreachable deployment must be
 * re-checked, not remembered.
 */
export async function assertVedaVaultUsable(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  vault: Address
): Promise<void> {
  if (!config.queueProgramAddress) {
    throw new SdpVedaError(
      "INCOMPATIBLE_DEPLOYMENT",
      `The Veda ${config.cluster} deployment declares no withdrawal queue, so SDP will not open ` +
        "a position in it. Money in requires a configured way out."
    );
  }

  const key = `${config.cluster}\n${runtime.rpcUrl}\n${vault}`;
  let entry = compatibility.get(key);
  if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
    compatibility.delete(key);
    entry = undefined;
  }
  if (!entry) {
    entry = { promise: validate(runtime, config, vault), expiresAt: null };
    compatibility.set(key, entry);
  }

  try {
    await entry.promise;
    if (compatibility.get(key) === entry && entry.expiresAt === null) {
      entry.expiresAt = Date.now() + VEDA_COMPATIBILITY_TTL_MS;
    }
  } catch (cause) {
    // Delete only if this is still the promise stored for the key: concurrent
    // callers may all observe the same rejection, and none may delete a newer
    // probe started after this one failed.
    if (compatibility.get(key) === entry) compatibility.delete(key);
    throw cause;
  }
}

async function validate(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  vault: Address
): Promise<void> {
  const veda = client(runtime, config);
  try {
    await veda.validateDeployment();
    await veda.vault(vault as Kit7).validateCompatibility({ requireQueue: true });
  } catch (cause) {
    throw mapVedaSdkError(cause, `Veda vault ${vault} is not usable on ${config.cluster}`);
  }
}

/** What asset resolution reads of the SDK's `listAssets` answer. */
const vaultAssetsSchema = z.array(z.looseObject({ mint: z.string() }));

/**
 * The single vault asset SDP fronts, resolved by MINT IDENTITY ALONE. Every
 * path takes it from `cachedAssetMint`, so this runs once per cache window.
 *
 * `EarnVaultDepositInput` and `EarnVaultPositionInput` carry no mint — the
 * catalogue row does, and the API compares the plan's/snapshot's identity
 * against it — so this has to arrive at the SAME asset the catalogue admitted.
 * It does that by applying the SAME predicate to the SAME source: the vault's
 * own configured assets, screened by `isVedaDepositMint(mint, cluster)`.
 *
 * Deliberately IGNORES `allow_deposits`, because both money directions resolve
 * through here and only one of them may consult that flag. A position read
 * gated on it would break the exit-safety rule the moment Veda paused deposits
 * (ADR 0002: reads and money-out never inherit a money-in gate) — precisely
 * when a holder most wants to see their balance. The DEPOSIT path re-checks the
 * flag live on the asset's own account (`assetTakesDeposits`) and refuses with
 * its own typed error.
 *
 * AMBIGUITY IS REFUSED, not resolved. Identity is cluster-exact, so while SDP
 * declares one deposit symbol there can be at most one match; if the symbol
 * list ever widens, "pick the first" is the kind of silent choice that spends
 * or values the wrong token. Widening `VEDA_DEPOSIT_TOKEN_SYMBOLS` therefore
 * means carrying a mint on the provider contract first; this error says so.
 */
async function resolveVaultAssetMint(
  config: VedaClusterConfig,
  vaultClient: Kit7,
  vault: Address
): Promise<Address> {
  let assets: z.infer<typeof vaultAssetsSchema>;
  try {
    assets = vaultAssetsSchema.parse(await vaultClient.listAssets());
  } catch (cause) {
    throw vaultUnreadable(vault, config.cluster, cause);
  }

  const candidates = assets
    .filter((asset) => isVedaDepositMint(asset.mint, config.cluster))
    .sort((left, right) => left.mint.localeCompare(right.mint));

  const [only, ...rest] = candidates;
  if (only === undefined) throw noFrontedAsset(config, vault);
  if (rest.length > 0) {
    throw new SdpVedaError(
      "UNSUPPORTED_VAULT",
      `Veda vault ${vault} configures ${candidates.length} assets SDP fronts on ` +
        `${config.cluster} (${candidates.map((asset) => asset.mint).join(", ")}), ` +
        "and neither a deposit nor a position read can say which one is meant. " +
        "Carry the mint on the provider contract before widening VEDA_DEPOSIT_TOKEN_SYMBOLS."
    );
  }

  return address(only.mint);
}

function noFrontedAsset(config: VedaClusterConfig, vault: Address): SdpVedaError {
  return new SdpVedaError(
    "UNSUPPORTED_VAULT",
    `Veda vault ${vault} configures no asset SDP fronts on ${config.cluster}.`
  );
}

/**
 * Whether the vault takes deposits of the asset SDP fronts, read LIVE from its
 * `AssetData` account on every deposit build. The cached asset mint only says
 * WHICH asset; the flag is never taken from it.
 *
 * The account is in the build's batched read, so this costs no request. It is
 * decoded with `@sdp/earn`'s layout, the bytes the catalogue reads the same
 * flag from, which `idl-layout.test.ts` pins to the committed IDL. An account
 * that is gone or no longer this vault's asset gets the answer a live asset
 * listing would have given, and the cached mint is dropped.
 */
async function assetTakesDeposits(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  operation: VaultOperation,
  vault: Address
): Promise<boolean> {
  const [assetDataAddress] = await findAssetDataPda(
    config.vaultProgramAddress,
    vault,
    operation.assetMint
  );
  let accounts: MaybeEncodedAccount[];
  try {
    accounts = await fetchEncodedAccounts(operation.shared.rpc, [assetDataAddress], {
      commitment: operation.shared.commitment,
    });
  } catch (cause) {
    throw vaultUnreadable(vault, config.cluster, cause);
  }
  const [account] = accounts;
  const asset =
    account.exists && account.programAddress === config.vaultProgramAddress
      ? decodeAssetData(account.data)
      : null;
  if (
    asset === null ||
    asset.vaultId !== operation.facts.vaultId ||
    asset.assetMint !== operation.assetMint
  ) {
    vaultAssetMints.delete(vaultFactsKey(runtime, config, vault));
    throw noFrontedAsset(config, vault);
  }
  return asset.allowDeposits;
}

/**
 * Build a deposit.
 *
 * `buildDeposit` — the INSTRUCTION-PLAN mode — never `prepareDeposit`. SDP owns
 * the blockhash, the fee payer, simulation and signing (`vault-execution.service`),
 * and a prepared transaction would arrive with a lifetime and a fee payer this
 * package has no business choosing.
 *
 * Returned as a single batch: a deposit touches one vault and creates at most
 * two idempotent associated token accounts, which fits one packet.
 */
export async function buildVedaDepositPlan(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  input: VedaDepositInput
): Promise<VedaInstructionPlan> {
  await assertVedaVaultUsable(runtime, config, input.vault);

  // The SDK's build previews, reads its quote context and the holder's
  // records, and the plan's existence checks read the same records: all from
  // one held read.
  const unreadable = (cause: unknown) => vaultUnreadable(input.vault, config.cluster, cause);
  const operation = await openVaultOperation(runtime, config, input.vault, unreadable);
  const { vaultClient } = operation;
  const assetDecimals = await holdWithAssetDecimals(
    runtime,
    config,
    operation,
    async () =>
      (
        await Promise.all([
          vaultQuoteAccounts(config, operation.facts, input.vault, operation.assetMint),
          holderAccounts(config, operation.facts, input.vault, input.owner),
        ])
      ).flat(),
    unreadable
  );
  let state: VaultShareFacts;
  try {
    state = vaultShareFactsOf(await vaultClient.getState());
  } catch (cause) {
    throw unreadable(cause);
  }

  // The deposit flag is checked HERE, on the money-in path only — never inside
  // asset resolution, which position reads share. `DEPOSIT_REFUSED` is the
  // caller-visible answer (the API maps it to a 400 with this sentence);
  // burying it in UNSUPPORTED_VAULT read as an SDP fault, not a vault state.
  if (!(await assetTakesDeposits(runtime, config, operation, input.vault))) {
    throw new SdpVedaError(
      "DEPOSIT_REFUSED",
      `Veda vault ${input.vault} currently has deposits disabled for ${operation.assetMint}.`
    );
  }
  // Precision is checked against each MINT, which is why it can only happen
  // after the vault is read: the deposit asset and the share token have
  // independent decimals and neither is knowable at the API boundary.
  const amount = acceptPositiveAtMintScale("amount", input.amount, assetDecimals);
  const minSharesOut = acceptPositiveAtMintScale(
    "minSharesOut",
    input.minSharesOut,
    shareMintDecimals(state.shareDecimals, input.vault)
  );

  let plan: { instructions: readonly Kit7[] };
  try {
    plan = await vaultClient.buildDeposit({
      owner: input.owner,
      asset: { kind: "mint", address: operation.assetMint },
      amount: amount.baseUnits,
      // `minAmountOut`, never `slippageBps`: a bps tolerance would be SDP
      // choosing a floor, and the floor a caller was quoted is the one that
      // must be encoded. The SDK refuses an implicit tolerance for the same
      // reason, and this passes that refusal through rather than defaulting.
      protection: { minAmountOut: minSharesOut.baseUnits },
    });
  } catch (cause) {
    throw mapVedaSdkError(cause, `Veda could not build a deposit for vault ${input.vault}`);
  }

  // Read from the same live state used to build, never from a catalogue
  // row: the API compares builder truth with catalogue metadata before
  // signing, and both sides being catalogue-derived would make that
  // comparison vacuous.
  const shareMint = state.shareMint;

  // The SDK's order and count preserved exactly — a Veda plan can carry
  // `protectedInstructionGroups` requiring adjacency, and the rent rewrite
  // swaps ONE ACCOUNT on the ATA creates without adding, dropping or
  // reordering anything. The swap is the only way to honour `rentPayer` here:
  // the SDK names the owner as every create's funding payer and offers no
  // alternative (see ./rent.ts).
  const sponsor =
    input.rentPayer === undefined || input.rentPayer === input.owner ? undefined : input.rentPayer;
  const instructions =
    sponsor === undefined
      ? [...plan.instructions]
      : [...chargeAtaCreationRentTo([...plan.instructions], sponsor)];

  // Whether rent is actually charged is chain state, not plan shape: the
  // create is idempotent, so only this read can say. The caller records the
  // answer to refund the right party when the account closes (contract and
  // pre-execution residual on `EarnVaultTransactionPlan.createsShareAccount`).
  const shareAta = createdAtaAddressForMint(instructions, shareMint);
  const createsShareAccount =
    shareAta === undefined
      ? undefined
      : !(await accountExists(operation.shared.rpc, operation.shared.commitment, shareAta));

  // The OTHER rent a first deposit owes, which the ATA swap above cannot
  // reach: the vault program lazily creates the depositor's AllowedUser
  // record INSIDE the deposit instruction and charges the SIGNER for it:
  // the payer is fixed by the program's own account table, so no
  // transaction-level sponsorship can substitute one. A sponsored plan
  // therefore pre-funds the owner with exactly that account's rent, which
  // the program's create consumes in the same transaction (mechanism and
  // residuals in ./allowed-user.ts). Wallet-pays plans change nothing: the
  // owner funds its own record, as the program intends.
  const allowedUser = allowedUserAccountForDeposit(instructions, config.vaultProgramAddress);
  let finalInstructions: readonly Instruction[] = instructions;
  if (
    sponsor !== undefined &&
    allowedUser !== undefined &&
    !(await accountExists(operation.shared.rpc, operation.shared.commitment, allowedUser))
  ) {
    const rent = await minimumBalanceForRentExemption(
      runtime.rpcUrl,
      VEDA_ALLOWED_USER_ACCOUNT_SIZE
    );
    finalInstructions = [prefundOwnerRentInstruction(sponsor, input.owner, rent), ...instructions];
  }

  return assertPlanTargetsCluster(
    {
      cluster: config.cluster,
      instructions: finalInstructions,
      lookupTables: [],
      assetIdentity: {
        depositTokenMint: operation.assetMint,
        shareMint,
      },
      accepted: { amount: amount.canonical, minSharesOut: minSharesOut.canonical },
      ...(createsShareAccount === undefined ? {} : { createsShareAccount }),
    },
    config
  );
}

/**
 * Quote a deposit — the READ a slippage floor is derived from.
 *
 * `previewDeposit` applies the vault's LIVE exchange rate, fees, premium, caps
 * and pause state to an amount and commits to nothing, so a floor of
 * `sharesOut × (1 − tolerance)` is truthful at any rate — the arithmetic a
 * caller might otherwise do on the deposit amount is only right while the rate
 * happens to be 1:1, and stops being right the day yield accrues.
 *
 * Deliberately NOT gated by `assertVedaVaultUsable`: that check demands the
 * withdrawal queue and exists to stop money going IN; a quote moves nothing,
 * and a read that consumed a money-in gate is the pattern ADR 0002 forbids.
 * Blocking conditions are RETURNED (`issues`) rather than thrown — "the vault
 * is paused" is an answer about the vault, not a failure to answer — while a
 * malformed amount stays a thrown `INVALID_AMOUNT`, because that one is about
 * the request.
 */
export async function previewVedaDeposit(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  input: VedaDepositQuoteInput
): Promise<VedaDepositQuote> {
  const unreadable = (cause: unknown) => vaultUnreadable(input.vault, config.cluster, cause);
  const operation = await openVaultOperation(runtime, config, input.vault, unreadable);
  const assetDecimals = await holdWithAssetDecimals(
    runtime,
    config,
    operation,
    () => vaultQuoteAccounts(config, operation.facts, input.vault, operation.assetMint),
    unreadable
  );
  const amount = acceptPositiveAtMintScale("amount", input.amount, assetDecimals);

  let quote: {
    sharesOut: bigint;
    shareDecimals: unknown;
    issues: readonly { code: unknown; message: unknown }[];
  };
  try {
    quote = await operation.vaultClient.previewDeposit({
      asset: { kind: "mint", address: operation.assetMint },
      amount: amount.baseUnits,
    });
  } catch (cause) {
    throw mapVedaSdkError(cause, `Veda could not quote a deposit for vault ${input.vault}`);
  }

  const shareDecimals = shareMintDecimals(quote.shareDecimals, input.vault);
  return {
    sharesOut: formatAtomic(quote.sharesOut, shareDecimals),
    shareDecimals,
    issues: quote.issues.map((issue) => ({
      code: String(issue.code),
      message: String(issue.message),
    })),
  };
}

/**
 * Build an INSTANT withdrawal: burn shares, receive the vault asset, in one
 * transaction (ADR 0003 — the queued exit is a separate capability and a
 * separate piece of work).
 *
 * Deliberately NOT gated by `assertVedaVaultUsable`: that check demands the
 * withdrawal QUEUE and exists to stop money going IN to a vault whose exit
 * infrastructure is missing. Demanding it on the way OUT would be exactly the
 * inversion ADR 0002 forbids — a customer must be able to leave through the
 * instant path even when the queue is broken. The vault's own refusals
 * (`RESTRICTED_REDEMPTION` when a withdraw authority is set, `SHARE_LOCKED`
 * inside the post-deposit lock window) surface as `WITHDRAW_REFUSED` with the
 * SDK's own sentence.
 *
 * `minAmountOut` is required for the same reason `minSharesOut` is on the
 * deposit: the SDK refuses an implicit slippage tolerance and SDP will not
 * choose one. The asset resolves exactly as the deposit's does — the vault's
 * own configured assets, cluster-exact, ambiguity refused — and deliberately
 * ignores `allow_deposits`, which gates the other money direction.
 *
 * The SDK's route check, preview, quote context and holding read all answer
 * from one held read.
 */
export async function buildVedaWithdrawPlan(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  input: VedaWithdrawInput
): Promise<VedaInstructionPlan> {
  const unreadable = (cause: unknown) => vaultUnreadable(input.vault, config.cluster, cause);
  const operation = await openVaultOperation(runtime, config, input.vault, unreadable);
  const { vaultClient } = operation;
  const assetDecimals = await holdWithAssetDecimals(
    runtime,
    config,
    operation,
    async () =>
      (
        await Promise.all([
          vaultQuoteAccounts(config, operation.facts, input.vault, operation.assetMint),
          holderAccounts(config, operation.facts, input.vault, input.owner),
          queueStateAccount(config, operation.facts),
        ])
      ).flat(),
    unreadable
  );
  let state: VaultShareFacts;
  try {
    state = vaultShareFactsOf(await vaultClient.getState());
  } catch (cause) {
    throw unreadable(cause);
  }

  const shares = acceptPositiveAtMintScale(
    "shares",
    input.shares,
    shareMintDecimals(state.shareDecimals, input.vault)
  );
  const minAmountOut = acceptPositiveAtMintScale("minAmountOut", input.minAmountOut, assetDecimals);

  let plan: { instructions: readonly Kit7[] };
  try {
    plan = await vaultClient.buildWithdraw({
      owner: input.owner,
      asset: operation.assetMint,
      shares: shares.baseUnits,
      // `minAmountOut`, never `slippageBps` — same rule as the deposit: the
      // floor the caller was quoted is the one that must be encoded.
      protection: { minAmountOut: minAmountOut.baseUnits },
    });
  } catch (cause) {
    throw mapVedaSdkError(
      cause,
      `Veda could not build a withdrawal for vault ${input.vault}`,
      "WITHDRAW_REFUSED"
    );
  }

  // Same rent rewrite as the deposit: an instant exit creates the owner's
  // ASSET account idempotently when it is missing, and the SDK names the owner
  // as its funding payer (see ./rent.ts). No share account is ever created on
  // the way out, so there is no `createsShareAccount` to report.
  const instructions =
    input.rentPayer === undefined || input.rentPayer === input.owner
      ? [...plan.instructions]
      : [...chargeAtaCreationRentTo([...plan.instructions], input.rentPayer)];

  return assertPlanTargetsCluster(
    {
      cluster: config.cluster,
      instructions,
      lookupTables: [],
      assetIdentity: {
        depositTokenMint: operation.assetMint,
        shareMint: state.shareMint,
      },
      accepted: { shares: shares.canonical, minAmountOut: minAmountOut.canonical },
    },
    config
  );
}

/**
 * Quote an instant withdrawal — the READ an exit floor is derived from.
 * `previewWithdraw` reports the vault's own accounting for these exact shares,
 * including its oracle and any withdraw premium; blocking conditions come back
 * as data (`issues`) rather than as errors, same as the deposit quote.
 */
export async function previewVedaWithdraw(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  input: VedaWithdrawQuoteInput
): Promise<VedaWithdrawQuote> {
  const unreadable = (cause: unknown) => vaultUnreadable(input.vault, config.cluster, cause);
  const operation = await openVaultOperation(runtime, config, input.vault, unreadable);
  const assetDecimals = await holdWithAssetDecimals(
    runtime,
    config,
    operation,
    () => vaultQuoteAccounts(config, operation.facts, input.vault, operation.assetMint),
    unreadable
  );
  let state: VaultShareFacts;
  try {
    state = vaultShareFactsOf(await operation.vaultClient.getState());
  } catch (cause) {
    throw unreadable(cause);
  }

  const shares = acceptPositiveAtMintScale(
    "shares",
    input.shares,
    shareMintDecimals(state.shareDecimals, input.vault)
  );

  let quote: {
    assetsOut: bigint;
    assetDecimals: unknown;
    issues: readonly { code: unknown; message: unknown }[];
  };
  try {
    quote = await operation.vaultClient.previewWithdraw({
      asset: operation.assetMint,
      shares: shares.baseUnits,
    });
  } catch (cause) {
    throw mapVedaSdkError(
      cause,
      `Veda could not quote a withdrawal for vault ${input.vault}`,
      "WITHDRAW_REFUSED"
    );
  }

  // The mint account's own decimals decide the scale: the floor derived from
  // `assetsOut` is quantized against these same decimals in the build, so
  // trusting a different number here would silently rescale it.
  return {
    assetsOut: formatAtomic(quote.assetsOut, assetDecimals),
    assetDecimals,
    issues: quote.issues.map((issue) => ({
      code: String(issue.code),
      message: String(issue.message),
    })),
  };
}

/**
 * Read, in ONE `getMultipleAccounts`, every account an operation's SDK calls
 * are about to fetch. Inside the operation's `withVedaOperationReads` scope
 * (`VedaVaultDirectClient` opens it) those calls are then answered from this
 * read, at its slot, so no account is fetched twice.
 *
 * It is a LIVE read: it runs in the caller's scope (read floor and minimum
 * slot), on the client the SDK reads through, with the SDK's own config. Only
 * the addresses come from cached facts. An account listed but never read costs
 * bytes, not a request; one the SDK reads that is not listed (an oracle named
 * by live asset data) is simply fetched on its own.
 */
async function holdAccounts(shared: SharedClient, accounts: readonly Address[]): Promise<void> {
  await shared.rpc
    .getMultipleAccounts([...new Set(accounts)], {
      commitment: shared.commitment,
      encoding: "base64",
    })
    .send();
}

/** The vault's queue state, which `getWithdrawalOptions` reads to report the queued route. */
async function queueStateAccount(
  config: VedaClusterConfig,
  facts: VaultShareFacts
): Promise<Address[]> {
  const queueProgram = config.queueProgramAddress;
  if (queueProgram === undefined) return [];
  const [queueState] = await findQueueStatePda(queueProgram, facts.vaultId);
  return [queueState];
}

/** The queue state and this asset's queue limits, which every queue route reads. */
async function queueStateAccounts(
  config: VedaClusterConfig,
  facts: VaultShareFacts,
  assetMint: Address
): Promise<Address[]> {
  const queueProgram = config.queueProgramAddress;
  if (queueProgram === undefined) return [];
  const [queueState, [withdrawAsset]] = await Promise.all([
    queueStateAccount(config, facts),
    findQueueWithdrawAssetPda(queueProgram, facts.vaultId, assetMint),
  ]);
  return [...queueState, withdrawAsset];
}

/**
 * What the SDK's quote context reads, in every preview and build: the vault,
 * the asset data and both mints. `getState` reads the vault and the share mint.
 */
async function vaultQuoteAccounts(
  config: VedaClusterConfig,
  facts: VaultShareFacts,
  vault: Address,
  assetMint: Address
): Promise<Address[]> {
  const [assetData] = await findAssetDataPda(config.vaultProgramAddress, vault, assetMint);
  return [vault, assetData, facts.shareMint, assetMint];
}

/** What a queued-withdrawal quote reads: the quote context and the queue. */
async function queueQuoteAccounts(
  config: VedaClusterConfig,
  facts: VaultShareFacts,
  vault: Address,
  assetMint: Address
): Promise<Address[]> {
  const [quote, queue] = await Promise.all([
    vaultQuoteAccounts(config, facts, vault, assetMint),
    queueStateAccounts(config, facts, assetMint),
  ]);
  return [...quote, ...queue];
}

/**
 * The queue's share escrow, the permission a vesting vault's queue holds, and
 * the share mint's transfer-hook accounts: what moving shares into or out of
 * the queue reads.
 */
async function queueEscrowAccounts(
  config: VedaClusterConfig,
  facts: VaultShareFacts,
  vault: Address
): Promise<Address[]> {
  const [[extraAccountMetas], [hookConfig]] = await Promise.all([
    findExtraAccountMetasPda(config.hookProgramAddress, facts.shareMint),
    findHookConfigPda(config.hookProgramAddress, facts.shareMint),
  ]);
  const hook = [facts.shareMint, config.hookProgramAddress, extraAccountMetas, hookConfig];
  const queueProgram = config.queueProgramAddress;
  if (queueProgram === undefined) return hook;
  const [queue] = await findQueuePda(queueProgram, facts.vaultId);
  const [queueShares, [permission]] = await Promise.all([
    vedaShareAccountAddress(queue, facts.shareMint),
    findPermissionPda(config.vaultProgramAddress, vault, queue),
  ]);
  return [...hook, queueShares, permission];
}

/** The holder's share account and allowed-user record, which `getUserPosition` reads. */
async function holderAccounts(
  config: VedaClusterConfig,
  facts: VaultShareFacts,
  vault: Address,
  owner: Address
): Promise<Address[]> {
  const [shareAccount, [allowedUser]] = await Promise.all([
    vedaShareAccountAddress(owner, facts.shareMint),
    findAllowedUserPda(config.vaultProgramAddress, vault, owner),
  ]);
  return [shareAccount, allowedUser];
}

/** The holder's records and queue nonce, which a request reads. */
async function queueHolderAccounts(
  config: VedaClusterConfig,
  facts: VaultShareFacts,
  vault: Address,
  owner: Address
): Promise<Address[]> {
  const holder = await holderAccounts(config, facts, vault, owner);
  const queueProgram = config.queueProgramAddress;
  if (queueProgram === undefined) return holder;
  const [userWithdrawState] = await findUserWithdrawStatePda(queueProgram, owner);
  return [...holder, userWithdrawState];
}

/** One operation's client and the vault's cached facts. */
interface VaultOperation {
  shared: SharedClient;
  vaultClient: Kit7;
  facts: VaultShareFacts;
  assetMint: Address;
}

/**
 * Open an operation on the shared client: the vault's static facts and the
 * asset SDP fronts, from the caches (`VEDA_READ_CACHE_TTL_MS`). Started
 * together, so a cold fill's repeated vault-state read is one request; a facts
 * failure is reported first, as the sequential reads did.
 */
async function openVaultOperation(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  vault: Address,
  factsFailure: (cause: unknown) => SdpVedaError
): Promise<VaultOperation> {
  const shared = sharedClient(runtime, config);
  const vaultClient = shared.veda.vault(vault);
  const [factsRead, mintRead] = await Promise.allSettled([
    cachedShareFacts(runtime, config, vaultClient, vault),
    cachedAssetMint(runtime, config, vaultClient, vault),
  ]);
  if (factsRead.status === "rejected") throw factsFailure(factsRead.reason);
  if (mintRead.status === "rejected") throw mintRead.reason;
  return { shared, vaultClient, facts: factsRead.value, assetMint: mintRead.value };
}

/**
 * Hold an operation's accounts (`holdAccounts`) while the fronted asset's
 * decimals come from their cache, read in the same round on the first call per
 * window. A failed hold is reported first, where the vault read it replaces
 * failed first.
 */
async function holdWithAssetDecimals(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  operation: VaultOperation,
  accounts: () => Promise<Address[]>,
  holdFailure: (cause: unknown) => SdpVedaError
): Promise<number> {
  const [heldRead, decimalsRead] = await Promise.allSettled([
    accounts().then((list) => holdAccounts(operation.shared, list)),
    cachedMintDecimals(runtime, config, operation.assetMint),
  ]);
  if (heldRead.status === "rejected") throw holdFailure(heldRead.reason);
  if (decimalsRead.status === "rejected") throw decimalsRead.reason;
  return decimalsRead.value;
}

/** Read both Veda exit routes and the SDP-facing asset's queue limits. */
export async function readVedaWithdrawalOptions(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  input: VedaWithdrawalOptionsInput
): Promise<VedaWithdrawalOptions> {
  const failure = (cause: unknown) =>
    mapVedaSdkError(cause, `Veda could not read withdrawal options for ${input.vault}`);
  const { shared, vaultClient, facts, assetMint } = await openVaultOperation(
    runtime,
    config,
    input.vault,
    failure
  );
  let options: {
    instant: boolean;
    queued: boolean;
    withdrawAuthority: Kit7;
    queueState: Kit7 | null;
  };
  try {
    await holdAccounts(shared, [
      input.vault,
      ...(await queueStateAccounts(config, facts, assetMint)),
    ]);
    options = await vaultClient.getWithdrawalOptions();
  } catch (cause) {
    throw failure(cause);
  }

  let queueAsset: {
    asset: Kit7;
    allowWithdrawals: boolean;
    secondsToMaturity: number;
    minimumSecondsToDeadline: number;
    minimumDiscountBps: number;
    maximumDiscountBps: number;
    minimumShares: bigint;
  } | null;
  try {
    queueAsset = await vaultClient.getQueueWithdrawalAsset(assetMint);
  } catch (cause) {
    throw mapVedaSdkError(cause, `Veda could not read queue limits for ${input.vault}`);
  }

  const shareDecimals = shareMintDecimals(facts.shareDecimals, input.vault);
  return {
    instant: options.instant,
    // The SDK's vault-level flag cannot account for this specific asset's
    // queue pause. Report the route as available only when both layers agree.
    queued: options.queued && queueAsset?.allowWithdrawals === true,
    withdrawAuthority: address(String(options.withdrawAuthority)),
    queueState: options.queueState === null ? null : address(String(options.queueState)),
    queueAsset:
      queueAsset === null
        ? null
        : {
            assetMint: address(String(queueAsset.asset)),
            allowWithdrawals: queueAsset.allowWithdrawals,
            secondsToMaturity: queueAsset.secondsToMaturity,
            minimumSecondsToDeadline: queueAsset.minimumSecondsToDeadline,
            maximumSecondsToDeadline: EARN_QUEUED_WITHDRAWAL_MAXIMUM_DEADLINE_SECONDS,
            minimumDiscountBps: queueAsset.minimumDiscountBps,
            maximumDiscountBps: queueAsset.maximumDiscountBps,
            minimumShares: formatAtomic(queueAsset.minimumShares, shareDecimals),
            shareDecimals,
          },
  };
}

/** A queue request's terms, checked against the share mint before any live read. */
interface QueueTerms {
  shares: AcceptedAmount;
  shareDecimals: number;
  discountBps: number;
  deadlineSeconds: number;
}

function queueTerms(facts: VaultShareFacts, input: VedaQueuedWithdrawalQuoteInput): QueueTerms {
  const shareDecimals = shareMintDecimals(facts.shareDecimals, input.vault);
  return {
    shares: acceptPositiveAtMintScale("shares", input.shares, shareDecimals),
    shareDecimals,
    discountBps: queueInteger("discountBps", input.discountBps, 65_535),
    deadlineSeconds: queueInteger("deadlineSeconds", input.deadlineSeconds, 4_294_967_295),
  };
}

/** What this module reads of the SDK's `previewRequestWithdrawal` answer. */
interface QueuedWithdrawalPreview {
  assetsOut: bigint;
  discountBps: number;
  maturityTimestamp: bigint;
  deadlineTimestamp: bigint;
  issues: readonly { code: unknown; message: unknown }[];
}

/** The SDK's request preview, inside an open operation whose accounts are held. */
async function quoteQueuedWithdrawal(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  operation: VaultOperation,
  vault: Address,
  terms: QueueTerms
): Promise<VedaQueuedWithdrawalQuote> {
  const [decimalsRead, quoteRead] = await Promise.allSettled([
    cachedMintDecimals(runtime, config, operation.assetMint),
    operation.vaultClient.previewRequestWithdrawal({
      asset: operation.assetMint,
      shares: terms.shares.baseUnits,
      discountBps: terms.discountBps,
      deadlineSeconds: terms.deadlineSeconds,
    }),
  ]);
  if (decimalsRead.status === "rejected") throw decimalsRead.reason;
  if (quoteRead.status === "rejected") {
    throw mapVedaSdkError(
      quoteRead.reason,
      `Veda could not quote a queued withdrawal for vault ${vault}`,
      "WITHDRAW_REFUSED"
    );
  }
  const quote: QueuedWithdrawalPreview = quoteRead.value;
  const assetDecimals = decimalsRead.value;
  return {
    assetMint: operation.assetMint,
    shares: terms.shares.canonical,
    shareDecimals: terms.shareDecimals,
    assets: formatAtomic(quote.assetsOut, assetDecimals),
    assetDecimals,
    discountBps: quote.discountBps,
    maturityTimestamp: quote.maturityTimestamp.toString(),
    deadlineTimestamp: quote.deadlineTimestamp.toString(),
    issues: quote.issues.map((issue) => ({
      code: String(issue.code),
      message: String(issue.message),
    })),
  };
}

/** Preview the discounted assets and exact maturity/deadline of a queue request. */
export async function previewVedaQueuedWithdrawal(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  input: VedaQueuedWithdrawalQuoteInput
): Promise<VedaQueuedWithdrawalQuote> {
  const unreadable = (cause: unknown) => vaultUnreadable(input.vault, config.cluster, cause);
  const operation = await openVaultOperation(runtime, config, input.vault, unreadable);
  const terms = queueTerms(operation.facts, input);
  try {
    await holdAccounts(
      operation.shared,
      await queueQuoteAccounts(config, operation.facts, input.vault, operation.assetMint)
    );
  } catch (cause) {
    throw unreadable(cause);
  }
  return quoteQueuedWithdrawal(runtime, config, operation, input.vault, terms);
}

/**
 * Build the holder's queue request. The request PDA is read from the emitted
 * instruction and verified against the expected queue program and owner.
 *
 * One operation: the quote that becomes `expectedRequest` and the SDK's build,
 * which previews, checks the holding and reads the queue's escrow and the share
 * hook again, all answer from one held read of every account involved.
 */
export async function buildVedaQueuedWithdrawalRequestPlan(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  input: VedaQueuedWithdrawalRequestInput
): Promise<VedaQueuedWithdrawalRequestPlan> {
  const unreadable = (cause: unknown) => vaultUnreadable(input.vault, config.cluster, cause);
  const operation = await openVaultOperation(runtime, config, input.vault, unreadable);
  const terms = queueTerms(operation.facts, input);
  try {
    const accounts = await Promise.all([
      queueQuoteAccounts(config, operation.facts, input.vault, operation.assetMint),
      queueEscrowAccounts(config, operation.facts, input.vault),
      queueHolderAccounts(config, operation.facts, input.vault, input.owner),
    ]);
    await holdAccounts(operation.shared, accounts.flat());
  } catch (cause) {
    throw unreadable(cause);
  }
  const quote = await quoteQueuedWithdrawal(runtime, config, operation, input.vault, terms);

  let sdkPlan: { instructions: readonly Kit7[] };
  try {
    sdkPlan = await operation.vaultClient.buildRequestWithdrawal({
      owner: input.owner,
      asset: operation.assetMint,
      shares: terms.shares.baseUnits,
      discountBps: terms.discountBps,
      deadlineSeconds: terms.deadlineSeconds,
    });
  } catch (cause) {
    throw mapVedaSdkError(
      cause,
      `Veda could not build a queued withdrawal for vault ${input.vault}`,
      "WITHDRAW_REFUSED"
    );
  }

  const queueProgram = config.queueProgramAddress;
  if (queueProgram === undefined) {
    throw new SdpVedaError(
      "UNSUPPORTED_VAULT",
      `The Veda ${config.cluster} deployment has no queued-withdrawal program.`
    );
  }
  const requestAddress = queuedWithdrawalRequestAddress(
    sdkPlan.instructions as readonly Instruction[],
    queueProgram,
    input.owner
  );
  if (requestAddress === undefined) {
    throw new SdpVedaError(
      "INCOMPATIBLE_DEPLOYMENT",
      "Veda's queued-withdrawal plan did not expose the expected request PDA."
    );
  }

  const sponsor =
    input.rentPayer === undefined || input.rentPayer === input.owner ? undefined : input.rentPayer;
  let instructions =
    sponsor === undefined
      ? ([...sdkPlan.instructions] as readonly Instruction[])
      : chargeAtaCreationRentTo(sdkPlan.instructions as readonly Instruction[], sponsor);
  if (sponsor !== undefined) {
    const accountSizes = queuedWithdrawalOwnerFundedAccountSizes(
      instructions,
      queueProgram,
      input.owner
    );
    const rents = await Promise.all(
      accountSizes.map((bytes) => minimumBalanceForRentExemption(runtime.rpcUrl, bytes))
    );
    const ownerFundedRent = rents.reduce((total, rent) => total + rent, 0n);
    if (ownerFundedRent > 0n) {
      instructions = [
        prefundOwnerRentInstruction(sponsor, input.owner, ownerFundedRent),
        ...instructions,
      ];
    }
  }

  const built: VedaQueuedWithdrawalRequestPlan = {
    cluster: config.cluster,
    instructions,
    lookupTables: [],
    assetIdentity: {
      depositTokenMint: operation.assetMint,
      shareMint: operation.facts.shareMint,
    },
    accepted: { shares: terms.shares.canonical },
    requestAddress,
    expectedRequest: {
      assetMint: quote.assetMint,
      shares: quote.shares,
      assets: quote.assets,
      discountBps: quote.discountBps,
      maturityTimestamp: quote.maturityTimestamp,
      deadlineTimestamp: quote.deadlineTimestamp,
    },
  };
  assertPlanTargetsCluster(built, config);
  return built;
}

/** Build the holder's post-deadline cancellation, which returns escrowed shares. */
export async function buildVedaQueuedWithdrawalCancelPlan(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  input: VedaQueuedWithdrawalCancelInput
): Promise<VedaInstructionPlan> {
  const shared = sharedClient(runtime, config);
  const vaultClient = shared.veda.vault(input.vault);
  let facts: VaultShareFacts;
  try {
    facts = await cachedShareFacts(runtime, config, vaultClient, input.vault);
  } catch (cause) {
    throw vaultUnreadable(input.vault, config.cluster, cause);
  }

  let lookup: Kit7;
  try {
    await holdAccounts(shared, [
      input.request,
      input.vault,
      ...(await queueEscrowAccounts(config, facts, input.vault)),
    ]);
    lookup = await vaultClient.getWithdrawalRequest(input.request as Kit7);
  } catch (cause) {
    if (cause instanceof VedaSdkError && cause.code === "ACCOUNT_NOT_FOUND") {
      throw new SdpVedaError(
        "WITHDRAWAL_REQUEST_NOT_FOUND",
        `Veda withdrawal request ${input.request} does not exist or is already closed.`,
        { cause }
      );
    }
    throw mapVedaSdkError(cause, `Veda could not read withdrawal request ${input.request}`);
  }
  if (lookup.status === "closedOrUnknown" || lookup.request === null) {
    throw new SdpVedaError(
      "WITHDRAWAL_REQUEST_NOT_FOUND",
      `Veda withdrawal request ${input.request} does not exist or is already closed.`
    );
  }

  const assetMint = await cachedAssetMint(runtime, config, vaultClient, input.vault);
  if (String(lookup.request.asset) !== assetMint) {
    throw new SdpVedaError(
      "UNSUPPORTED_VAULT",
      `Veda withdrawal request ${input.request} uses asset ${lookup.request.asset}, ` +
        `not SDP's ${assetMint}.`
    );
  }

  let sdkPlan: { instructions: readonly Kit7[] };
  try {
    sdkPlan = await vaultClient.buildCancelWithdrawal({
      owner: input.owner as Kit7,
      request: input.request as Kit7,
    });
  } catch (cause) {
    if (cause instanceof VedaSdkError && cause.code === "ACCOUNT_NOT_FOUND") {
      throw new SdpVedaError(
        "WITHDRAWAL_REQUEST_NOT_FOUND",
        `Veda withdrawal request ${input.request} closed before its cancellation could be built.`,
        { cause }
      );
    }
    throw mapVedaSdkError(
      cause,
      `Veda could not cancel withdrawal request ${input.request}`,
      "WITHDRAW_REFUSED"
    );
  }

  return assertPlanTargetsCluster(
    {
      cluster: config.cluster,
      instructions: [...sdkPlan.instructions],
      lookupTables: [],
      assetIdentity: {
        depositTokenMint: assetMint,
        shareMint: facts.shareMint,
      },
      accepted: {
        shares: formatAtomic(
          BigInt(lookup.request.shares),
          shareMintDecimals(facts.shareDecimals, input.vault)
        ),
      },
    },
    config
  );
}

/** The asset SDP fronts and its decimals, for decimalizing durable request reads. */
async function requestScales(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  vaultClient: Kit7,
  vault: Address
): Promise<{ facts: VaultShareFacts; assetMint: Address; assetDecimals: number }> {
  const [factsRead, mintRead] = await Promise.allSettled([
    cachedShareFacts(runtime, config, vaultClient, vault),
    cachedAssetMint(runtime, config, vaultClient, vault),
  ]);
  if (factsRead.status === "rejected") {
    throw vaultUnreadable(vault, config.cluster, factsRead.reason);
  }
  if (mintRead.status === "rejected") throw mintRead.reason;
  return {
    facts: factsRead.value,
    assetMint: mintRead.value,
    assetDecimals: await cachedMintDecimals(runtime, config, mintRead.value),
  };
}

/** List the still-open requests for this owner and SDP-facing vault asset. */
export async function readVedaQueuedWithdrawalRequests(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  input: VedaQueuedWithdrawalRequestsInput
): Promise<VedaQueuedWithdrawalRequest[]> {
  const vaultClient = sharedClient(runtime, config, "finalized").veda.vault(input.vault);
  let requests: readonly Kit7[];
  try {
    requests = await vaultClient.listOpenWithdrawalRequests(input.owner as Kit7);
  } catch (cause) {
    throw mapVedaSdkError(cause, `Veda could not list withdrawal requests for ${input.owner}`);
  }
  const { facts, assetMint, assetDecimals } = await requestScales(
    runtime,
    config,
    vaultClient,
    input.vault
  );
  const shareDecimals = shareMintDecimals(facts.shareDecimals, input.vault);
  return requests
    .filter((request) => String(request.asset) === assetMint)
    .map((request) => queuedRequestView(request, input.vault, shareDecimals, assetDecimals));
}

/** Read one request, preserving the SDK's honest closed-or-unknown terminal state. */
export async function readVedaQueuedWithdrawalRequest(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  input: VedaQueuedWithdrawalRequestInputByAddress
): Promise<VedaQueuedWithdrawalRequestLookup> {
  // Reconciliation persists these terms and later treats them as immutable.
  const shared = sharedClient(runtime, config, "finalized");
  const vaultClient = shared.veda.vault(input.vault);
  let lookup: Kit7;
  try {
    await holdAccounts(shared, [input.request, input.vault]);
    lookup = await vaultClient.getWithdrawalRequest(input.request as Kit7);
  } catch (cause) {
    throw mapVedaSdkError(cause, `Veda could not read withdrawal request ${input.request}`);
  }
  if (lookup.status === "closedOrUnknown" || lookup.request === null) {
    return { requestAddress: input.request, status: "closedOrUnknown", request: null };
  }

  const { facts, assetMint, assetDecimals } = await requestScales(
    runtime,
    config,
    vaultClient,
    input.vault
  );
  if (String(lookup.request.asset) !== assetMint) {
    throw new SdpVedaError(
      "UNSUPPORTED_VAULT",
      `Veda withdrawal request ${input.request} uses an asset SDP does not front for this vault.`
    );
  }
  const request = queuedRequestView(
    lookup.request,
    input.vault,
    shareMintDecimals(facts.shareDecimals, input.vault),
    assetDecimals
  );
  return { requestAddress: input.request, status: request.status, request };
}

/** Decode queue lifecycle logs without allowing the SDK's Kit-7 types to escape. */
export function parseVedaWithdrawalLifecycleEvents(
  logs: readonly string[] | null | undefined,
  scales: VedaWithdrawalLifecycleScales
): readonly VedaWithdrawalLifecycleEvent[] {
  const shareDecimals = mintDecimals(scales.shareDecimals, "share decimals");
  const assetDecimals = mintDecimals(scales.assetDecimals, "asset decimals");
  const trustedLogs = lifecycleLogsEmittedByProgram(logs, String(scales.queueProgramAddress));
  return parseLifecycleEvents(trustedLogs).flatMap(
    (event: Kit7): VedaWithdrawalLifecycleEvent[] => {
      switch (event.kind) {
        case "withdrawalRequested":
          return [
            {
              kind: event.kind,
              queueState: address(String(event.queueState)),
              requestAddress: address(String(event.request)),
              vaultId: BigInt(event.vaultId).toString(),
              owner: address(String(event.user)),
              assetMint: address(String(event.assetMint)),
              nonce: BigInt(event.nonce).toString(),
              shares: formatAtomic(BigInt(event.shares), shareDecimals),
              assets: formatAtomic(BigInt(event.assets), assetDecimals),
              creationTimestamp: BigInt(event.creationTime).toString(),
              maturityTimestamp: BigInt(event.maturityTime).toString(),
              deadlineTimestamp: BigInt(event.deadline).toString(),
            },
          ];
        case "withdrawalCancelled":
          return [
            {
              kind: event.kind,
              queueState: address(String(event.queueState)),
              requestAddress: address(String(event.request)),
              vaultId: BigInt(event.vaultId).toString(),
              owner: address(String(event.user)),
              assetMint: address(String(event.assetMint)),
              nonce: BigInt(event.nonce).toString(),
              sharesReturned: formatAtomic(BigInt(event.sharesReturned), shareDecimals),
              cancelledAt: BigInt(event.cancelledAt).toString(),
            },
          ];
        case "withdrawalFulfilled":
          return [
            {
              kind: event.kind,
              queueState: address(String(event.queueState)),
              requestAddress: address(String(event.request)),
              vaultId: BigInt(event.vaultId).toString(),
              owner: address(String(event.user)),
              assetMint: address(String(event.assetMint)),
              nonce: BigInt(event.nonce).toString(),
              sharesBurned: formatAtomic(BigInt(event.sharesBurned), shareDecimals),
              assetsPaid: formatAtomic(BigInt(event.assetsPaid), assetDecimals),
              vaultAssetsOut: formatAtomic(BigInt(event.vaultAssetsOut), assetDecimals),
              excessReturned: formatAtomic(BigInt(event.excessReturned), assetDecimals),
              fulfilledAt: BigInt(event.fulfilledAt).toString(),
            },
          ];
        default:
          return [];
      }
    }
  );
}

/**
 * Anchor's event parser accepts any `Program data:` line and cannot know which
 * program emitted it. Preserve only lines emitted while the configured queue
 * program is the active invocation frame; otherwise a later transaction that
 * merely mentions a closed request PDA could forge a terminal-looking event.
 */
function lifecycleLogsEmittedByProgram(
  logs: readonly string[] | null | undefined,
  expectedProgram: string
): readonly string[] {
  if (!logs) return [];
  const invocationStack: string[] = [];
  const trusted: string[] = [];
  for (const log of logs) {
    const invocation = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/.exec(log);
    if (invocation) {
      const depth = Number(invocation[2]);
      if (!Number.isSafeInteger(depth) || depth < 1 || depth > invocationStack.length + 1) {
        invocationStack.length = 0;
        continue;
      }
      invocationStack.length = depth - 1;
      invocationStack.push(invocation[1] ?? "");
      continue;
    }

    const completion = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed:.*)$/.exec(log);
    if (completion) {
      if (invocationStack.at(-1) !== completion[1]) {
        invocationStack.length = 0;
      } else {
        invocationStack.pop();
      }
      continue;
    }

    if (log.startsWith("Program data: ") && invocationStack.at(-1) === expectedProgram) {
      trusted.push(log);
    }
  }
  return trusted;
}

function queuedRequestView(
  request: Kit7,
  vault: Address,
  shareDecimals: number,
  assetDecimals: number
): VedaQueuedWithdrawalRequest {
  return {
    requestAddress: address(String(request.address)),
    vault,
    owner: address(String(request.user)),
    nonce: BigInt(request.nonce).toString(),
    assetMint: address(String(request.asset)),
    shares: formatAtomic(BigInt(request.shares), shareDecimals),
    assets: formatAtomic(BigInt(request.assets), assetDecimals),
    creationTimestamp: BigInt(request.creationTimestamp).toString(),
    maturityTimestamp: BigInt(request.maturityTimestamp).toString(),
    deadlineTimestamp: BigInt(request.deadlineTimestamp).toString(),
    status: request.status,
  };
}

function queueInteger(field: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new SdpVedaError(
      "INVALID_QUEUE_PARAMETERS",
      `Veda ${field} must be an integer between 0 and ${maximum}; received ${String(value)}`
    );
  }
  return value;
}

/** What a position read uses of the SDK's `getUserPosition` answer. */
const userPositionSchema = z.looseObject({
  shareAccount: z.string(),
  shares: z.bigint(),
  unlockTimestamp: z.bigint().optional(),
});

/**
 * One wallet's holding in one vault, read live.
 *
 * Shares come from `getUserPosition`, which reads the owner's Token-2022 share
 * account and returns an EXACT atomic `bigint` — never a JSON `uiAmount`, which
 * loses value above 2^53 base units.
 *
 * The valuation is allowed to fail INDEPENDENTLY of the share read: a position
 * whose size is known but whose value is not renders "—", which is the module
 * rule everywhere in Earn and strictly better than a fabricated number. It uses
 * `previewWithdraw`, so the figure is the vault's own accounting — including its
 * oracle and any withdraw premium — rather than arithmetic this package invents
 * on top of a raw exchange rate. That makes it a REDEEMABLE value, which is the
 * conservative one to show a holder.
 *
 * Only the holding and its value are read per call, in one batched read
 * (`holdAccounts`) that both SDK calls answer from. The vault's static facts
 * (share mint, share decimals, the fronted asset's mint) and the validated SDK
 * client are reused for `VEDA_READ_CACHE_TTL_MS`; see `sharedClient`.
 */
export async function readVedaPosition(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  input: VedaPositionInput
): Promise<VedaPosition> {
  const unreadable = (cause: unknown) => vaultUnreadable(input.vault, config.cluster, cause);
  const operation = await openVaultOperation(runtime, config, input.vault, unreadable);
  const { vaultClient } = operation;
  let position: z.infer<typeof userPositionSchema>;
  try {
    const accounts = await Promise.all([
      vaultQuoteAccounts(config, operation.facts, input.vault, operation.assetMint),
      holderAccounts(config, operation.facts, input.vault, input.owner),
    ]);
    await holdAccounts(operation.shared, accounts.flat());
    position = userPositionSchema.parse(await vaultClient.getUserPosition(input.owner));
  } catch (cause) {
    throw unreadable(cause);
  }
  let state = operation.facts;
  // The SDK derived the share account from LIVE vault state, so a mismatch
  // means the cached share mint is stale: drop it and read the state again.
  if (!(await holdsShareAccount(input.owner, state.shareMint, position.shareAccount))) {
    vaultShareFacts.delete(vaultFactsKey(runtime, config, input.vault));
    try {
      state = vaultShareFactsOf(await vaultClient.getState());
    } catch (cause) {
      throw unreadable(cause);
    }
    if (!(await holdsShareAccount(input.owner, state.shareMint, position.shareAccount))) {
      throw unreadable(
        new Error("The holder's share account does not belong to the vault's share mint")
      );
    }
  }
  const asset = { mint: operation.assetMint };
  const shareDecimals = shareMintDecimals(state.shareDecimals, input.vault);

  // The Boring vault share lock covers the WHOLE account until its unlock
  // instant, so redeemable-now is all-or-nothing. Compared against the local
  // clock: the skew window is seconds around a boundary the caller cannot act
  // inside anyway, and claiming locked shares withdrawable would be the lie
  // that matters.
  const locked =
    position.unlockTimestamp !== undefined &&
    position.unlockTimestamp > BigInt(Math.floor(Date.now() / 1000));

  return {
    vault: input.vault,
    owner: input.owner,
    cluster: config.cluster,
    shares: formatAtomic(position.shares, shareDecimals),
    withdrawableShares: formatAtomic(locked ? 0n : position.shares, shareDecimals),
    unlockTimestamp: position.unlockTimestamp?.toString() ?? null,
    ...(await valuation(vaultClient, asset, position.shares)),
    tokenMint: asset.mint,
    shareMint: state.shareMint,
  };
}

async function valuation(
  vaultClient: Kit7,
  asset: { mint: Address },
  shares: bigint
): Promise<{ tokenValue?: string }> {
  // The SDK refuses a zero-share quote, and there is nothing to ask: zero shares
  // are worth zero of anything, exactly. `formatAtomic(0n, d)` is "0" for every
  // d, so saying so needs no mint read.
  if (shares === 0n) return { tokenValue: "0" };
  try {
    const quote = await vaultClient.previewWithdraw({ asset: asset.mint as Kit7, shares });
    return {
      tokenValue: formatAtomic(quote.assetsOut, mintDecimals(quote.assetDecimals, "quote")),
    };
  } catch {
    // Deliberately swallowed. A stale oracle, a disabled withdrawal asset or a
    // paused vault all make the VALUE unknown without making the HOLDING
    // unknown, and reporting the holding is the more important half.
    return {};
  }
}

/**
 * Share-mint decimals from SDK state, kept inside this package's taxonomy.
 *
 * `mintDecimals` throws a bare `Error` on an unusable value (missing, or over
 * Solana's 9-decimal cap); uncaught, that reads as an unclassified 500. A share
 * mint reporting nonsense means the vault state is not usable, which is what
 * `VAULT_UNREADABLE` says.
 */
function shareMintDecimals(value: unknown, vault: Address): number {
  try {
    return mintDecimals(value, "share decimals");
  } catch (cause) {
    throw new SdpVedaError(
      "VAULT_UNREADABLE",
      `Veda vault ${vault} did not report a usable share-mint decimal count`,
      { cause }
    );
  }
}

function formatAtomic(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? "" : digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

/**
 * Translate a `VedaSdkError` into this package's taxonomy, at the boundary.
 *
 * The mapping is what makes the SDK's codes actionable: `DEPOSIT_REFUSED` is a
 * caller-visible 400 ("the vault will not take this right now"), while
 * `VAULT_UNREADABLE` is an infrastructure answer. The distinction matters
 * because `INVALID_AMOUNT` carries BOTH — the SDK reuses it for a genuinely bad
 * number and for a quote issue such as `TELLER_PAUSED` or `DEPOSIT_CAP_EXCEEDED`,
 * discriminated only by an `issue` in its context.
 *
 * Unmapped codes fall to `VAULT_UNREADABLE` on purpose: that bucket is not
 * caller-fixable, so an unrecognised failure is never rendered to a customer as
 * "your request was wrong". The SDK's own message and the original error are
 * preserved either way.
 */
export function mapVedaSdkError(
  cause: unknown,
  context: string,
  // Which money direction's refusal code a vault refusal maps to. The SDK's
  // SHARE_LOCKED / RESTRICTED_REDEMPTION / NOT_ALLOWED family reads the same
  // either way; the caller-facing code should name the direction that failed.
  refusalCode: "DEPOSIT_REFUSED" | "WITHDRAW_REFUSED" = "DEPOSIT_REFUSED"
): SdpVedaError {
  if (cause instanceof SdpVedaError) return cause;
  if (!(cause instanceof VedaSdkError)) {
    return new SdpVedaError("VAULT_UNREADABLE", `${context}: ${describe(cause)}`, { cause });
  }

  const message = `${context}: ${cause.message}`;
  switch (cause.code) {
    case "COMPLIANCE_APPROVAL_REQUIRED":
    case "INVALID_COMPLIANCE_APPROVAL":
      // v1 does NOT implement Veda's compliance-approval flow: it needs a
      // signed approval from Veda's compliance service, which is a deliberate
      // later decision rather than something to fake at the boundary.
      return new SdpVedaError(
        "COMPLIANCE_APPROVAL_REQUIRED",
        `${message} SDP does not implement Veda's compliance-approval flow.`,
        { cause }
      );
    case "INVALID_AMOUNT":
      // `issue` present means the vault refused the request (paused, capped,
      // asset disabled, insufficient balance); absent means the number itself
      // was unusable.
      return new SdpVedaError("issue" in cause.context ? refusalCode : "INVALID_AMOUNT", message, {
        cause,
      });
    case "ZERO_SHARES":
      return new SdpVedaError("INVALID_AMOUNT", message, { cause });
    case "NOT_ALLOWED":
    case "SHARE_LOCKED":
    case "RESTRICTED_REDEMPTION":
      return new SdpVedaError(refusalCode, message, { cause });
    case "INCOMPATIBLE_DEPLOYMENT":
      return new SdpVedaError("INCOMPATIBLE_DEPLOYMENT", message, { cause });
    case "QUEUE_NOT_CONFIGURED":
    case "TRANSFER_FEE_MINT_UNSUPPORTED":
    case "UNSUPPORTED_CPI_DIGEST_ASSET":
      return new SdpVedaError("UNSUPPORTED_VAULT", message, { cause });
    case "INVALID_QUEUE_PARAMETERS":
      return new SdpVedaError("INVALID_QUEUE_PARAMETERS", message, { cause });
    case "SLIPPAGE_PROTECTION_REQUIRED":
      // Unreachable: this package always supplies `minAmountOut`. Mapped
      // anyway, so a future path that forgets gets a caller-fixable answer
      // rather than an infrastructure one.
      return new SdpVedaError("INVALID_AMOUNT", message, { cause });
    default:
      return new SdpVedaError("VAULT_UNREADABLE", message, { cause });
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
