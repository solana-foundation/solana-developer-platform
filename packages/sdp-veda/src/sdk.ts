import { isVedaDepositMint } from "@sdp/types/veda-programs";
import { type Address, address } from "@solana/kit";
import { createVedaClient, VedaSdkError } from "@vedatech/svm-sdk";
import { accountExists } from "./accounts";
import { acceptPositiveAtMintScale, mintDecimals } from "./amounts";
import { SdpVedaError, vaultUnreadable } from "./errors";
import { assertPlanTargetsCluster } from "./guards";
import { readMintDecimals } from "./mint";
import type { VedaClusterConfig } from "./programs";
import { chargeAtaCreationRentTo, createdAtaAddressForMint } from "./rent";
import { createVedaRpc } from "./rpc";
import type {
  VedaDepositInput,
  VedaDepositQuote,
  VedaDepositQuoteInput,
  VedaInstructionPlan,
  VedaPosition,
  VedaPositionInput,
  VedaRuntime,
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
 * The SDK is built against `@solana/kit` **7.0.0**; this repo pins **6.8.0**,
 * and pnpm nests the SDK's own copy, so both live in the tree (alongside the
 * 2.3.0 klend-sdk drags in and a 5.5.1). Every cast below is a STRUCTURAL
 * re-label across that seam, not a coercion: kit's `Instruction` is a plain
 * object with `programAddress`, a numeric `AccountRole` and `Uint8Array` data
 * in both majors, and nothing kit-typed crosses this module's exports — see
 * `./types.ts`.
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

function client(runtime: VedaRuntime, config: VedaClusterConfig) {
  // The transport deadline covers both our direct reads and every nested vault,
  // asset, oracle and mint request the SDK performs with this same client.
  const rpc = createVedaRpc(runtime.rpcUrl) as Kit7;
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
    commitment: "confirmed",
  });
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

/**
 * The single vault asset SDP fronts, resolved by MINT IDENTITY ALONE.
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
 * flag on the returned asset and refuses with its own typed error.
 *
 * AMBIGUITY IS REFUSED, not resolved. Identity is cluster-exact, so while SDP
 * declares one deposit symbol there can be at most one match; if the symbol
 * list ever widens, "pick the first" is the kind of silent choice that spends
 * or values the wrong token. Widening `VEDA_DEPOSIT_TOKEN_SYMBOLS` therefore
 * means carrying a mint on the provider contract first; this error says so.
 */
async function resolveVaultAsset(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  vaultClient: Kit7,
  vault: Address
): Promise<{ mint: Address; decimals: number; allowDeposits: boolean }> {
  let assets: { mint: Kit7; allowDeposits: boolean }[];
  try {
    assets = await vaultClient.listAssets();
  } catch (cause) {
    throw vaultUnreadable(String(vault), config.cluster, cause);
  }

  const candidates = assets
    .filter((asset) => isVedaDepositMint(String(asset.mint), config.cluster))
    .sort((left, right) => String(left.mint).localeCompare(String(right.mint)));

  const [only, ...rest] = candidates;
  if (only === undefined) {
    throw new SdpVedaError(
      "UNSUPPORTED_VAULT",
      `Veda vault ${vault} configures no asset SDP fronts on ${config.cluster}.`
    );
  }
  if (rest.length > 0) {
    throw new SdpVedaError(
      "UNSUPPORTED_VAULT",
      `Veda vault ${vault} configures ${candidates.length} assets SDP fronts on ` +
        `${config.cluster} (${candidates.map((asset) => String(asset.mint)).join(", ")}), ` +
        "and neither a deposit nor a position read can say which one is meant. " +
        "Carry the mint on the provider contract before widening VEDA_DEPOSIT_TOKEN_SYMBOLS."
    );
  }

  const mint = address(String(only.mint));
  return {
    mint,
    decimals: await readMintDecimals(runtime.rpcUrl, mint),
    allowDeposits: only.allowDeposits,
  };
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

  const vaultClient = client(runtime, config).vault(input.vault as Kit7);
  let state: { shareMint: Kit7; shareDecimals: unknown };
  try {
    state = await vaultClient.getState();
  } catch (cause) {
    throw vaultUnreadable(String(input.vault), config.cluster, cause);
  }

  const asset = await resolveVaultAsset(runtime, config, vaultClient, input.vault);
  // The deposit flag is checked HERE, on the money-in path only — never inside
  // asset resolution, which position reads share. `DEPOSIT_REFUSED` is the
  // caller-visible answer (the API maps it to a 400 with this sentence);
  // burying it in UNSUPPORTED_VAULT read as an SDP fault, not a vault state.
  if (!asset.allowDeposits) {
    throw new SdpVedaError(
      "DEPOSIT_REFUSED",
      `Veda vault ${input.vault} currently has deposits disabled for ${asset.mint}.`
    );
  }
  // Precision is checked against each MINT, which is why it can only happen
  // after the vault is read: the deposit asset and the share token have
  // independent decimals and neither is knowable at the API boundary.
  const amount = acceptPositiveAtMintScale("amount", input.amount, asset.decimals);
  const minSharesOut = acceptPositiveAtMintScale(
    "minSharesOut",
    input.minSharesOut,
    shareMintDecimals(state.shareDecimals, input.vault)
  );

  let plan: { instructions: readonly Kit7[] };
  try {
    plan = await vaultClient.buildDeposit({
      owner: input.owner as Kit7,
      asset: { kind: "mint", address: asset.mint as Kit7 },
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
  const shareMint = address(String(state.shareMint));

  // The SDK's order and count preserved exactly — a Veda plan can carry
  // `protectedInstructionGroups` requiring adjacency, and the rent rewrite
  // swaps ONE ACCOUNT on the ATA creates without adding, dropping or
  // reordering anything. The swap is the only way to honour `rentPayer` here:
  // the SDK names the owner as every create's funding payer and offers no
  // alternative (see ./rent.ts).
  const instructions =
    input.rentPayer === undefined || input.rentPayer === input.owner
      ? [...plan.instructions]
      : [...chargeAtaCreationRentTo([...plan.instructions], input.rentPayer)];

  // Whether rent is actually charged is chain state, not plan shape: the
  // create is idempotent, so only this read can say. The caller records the
  // answer to refund the right party when the account closes (contract and
  // pre-execution residual on `EarnVaultTransactionPlan.createsShareAccount`).
  const shareAta = createdAtaAddressForMint(instructions, shareMint);
  const createsShareAccount =
    shareAta === undefined ? undefined : !(await accountExists(runtime.rpcUrl, shareAta));

  return assertPlanTargetsCluster(
    {
      cluster: config.cluster,
      instructions,
      lookupTables: [],
      assetIdentity: {
        depositTokenMint: asset.mint,
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
  const vaultClient = client(runtime, config).vault(input.vault as Kit7);
  const asset = await resolveVaultAsset(runtime, config, vaultClient, input.vault);
  const amount = acceptPositiveAtMintScale("amount", input.amount, asset.decimals);

  let quote: {
    sharesOut: bigint;
    shareDecimals: unknown;
    issues: readonly { code: unknown; message: unknown }[];
  };
  try {
    quote = await vaultClient.previewDeposit({
      asset: { kind: "mint", address: asset.mint as Kit7 },
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
 */
export async function buildVedaWithdrawPlan(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  input: VedaWithdrawInput
): Promise<VedaInstructionPlan> {
  const vaultClient = client(runtime, config).vault(input.vault as Kit7);
  let state: { shareMint: Kit7; shareDecimals: unknown };
  try {
    state = await vaultClient.getState();
  } catch (cause) {
    throw vaultUnreadable(String(input.vault), config.cluster, cause);
  }

  const asset = await resolveVaultAsset(runtime, config, vaultClient, input.vault);
  const shares = acceptPositiveAtMintScale(
    "shares",
    input.shares,
    shareMintDecimals(state.shareDecimals, input.vault)
  );
  const minAmountOut = acceptPositiveAtMintScale(
    "minAmountOut",
    input.minAmountOut,
    asset.decimals
  );

  let plan: { instructions: readonly Kit7[] };
  try {
    plan = await vaultClient.buildWithdraw({
      owner: input.owner as Kit7,
      asset: asset.mint as Kit7,
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
        depositTokenMint: asset.mint,
        shareMint: address(String(state.shareMint)),
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
  const vaultClient = client(runtime, config).vault(input.vault as Kit7);
  let state: { shareMint: Kit7; shareDecimals: unknown };
  try {
    state = await vaultClient.getState();
  } catch (cause) {
    throw vaultUnreadable(String(input.vault), config.cluster, cause);
  }

  const asset = await resolveVaultAsset(runtime, config, vaultClient, input.vault);
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
    quote = await vaultClient.previewWithdraw({
      asset: asset.mint as Kit7,
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
  // `assetsOut` is quantized against `asset.decimals` in the build, so trusting
  // a different number here would silently rescale it.
  const assetDecimals = asset.decimals;
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
 */
export async function readVedaPosition(
  runtime: VedaRuntime,
  config: VedaClusterConfig,
  input: VedaPositionInput
): Promise<VedaPosition> {
  const vaultClient = client(runtime, config).vault(input.vault as Kit7);

  let state: { shareMint: Kit7; shareDecimals: unknown };
  let position: { shares: bigint; unlockTimestamp: bigint | undefined };
  try {
    state = await vaultClient.getState();
    position = await vaultClient.getUserPosition(input.owner as Kit7);
  } catch (cause) {
    throw vaultUnreadable(String(input.vault), config.cluster, cause);
  }

  const asset = await resolveVaultAsset(runtime, config, vaultClient, input.vault);
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
    ...(await valuation(vaultClient, asset, position.shares)),
    tokenMint: asset.mint,
    shareMint: address(String(state.shareMint)),
  };
}

async function valuation(
  vaultClient: Kit7,
  asset: { mint: Address; decimals: number },
  shares: bigint
): Promise<{ tokenValue?: string }> {
  // The SDK refuses a zero-share quote, and there is nothing to ask: zero shares
  // are worth zero of anything, exactly.
  if (shares === 0n) return { tokenValue: formatAtomic(0n, asset.decimals) };
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
    case "INVALID_QUEUE_PARAMETERS":
    case "TRANSFER_FEE_MINT_UNSUPPORTED":
    case "UNSUPPORTED_CPI_DIGEST_ASSET":
      return new SdpVedaError("UNSUPPORTED_VAULT", message, { cause });
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
