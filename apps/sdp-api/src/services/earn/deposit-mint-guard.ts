// biome-ignore-all lint/security/noSecrets: public Solana mint and authority addresses, verified against chain; not secrets.
/**
 * Earn deposit-mint extension guard (PRO-1962).
 *
 * Two of Earn's deposit stablecoins, PYUSD and USDG, are Token-2022 mints whose
 * issuer (Paxos) keeps a MUTABLE transfer-hook authority and a permanent
 * delegate on both clusters. The deployed Kora signs sponsored movements of
 * those mints with `transfer_hook_policy = "allow_all"`, which means Kora will
 * not refuse to co-sign a transaction whose hook program changed between
 * building and signing. That is a deliberate trust decision about the issuer,
 * and this module is the monitor that decision was made on: every metrics
 * refresh reads each Token-2022 deposit mint on each cluster and compares the
 * hook program, hook authority and permanent delegate against the values
 * pinned below. Any difference is an alertable event
 * (`sdp-infra/kora/alert-rules/sdp-earn-deposit-mint-drift*.json`).
 *
 * The same read answers the Earn row of the capability table (ADR 0012,
 * `support(terms, "earn")` in `@sdp/solana/token-movement`): a deposit mint
 * whose Token Terms Earn's provider builders cannot move (a fee that is
 * charged, a hook program set, paused, frozen by default, non-transferable)
 * is reported as `earn_support` drift. Earn's deposit builders read no
 * deposit mint, so gating each build would add a mint read to every deposit;
 * this guard is where the decision is made instead.
 *
 * Report-only, like the catalogue anomaly check: nothing here blocks a deposit
 * or an exit. A hook that appears on PYUSD is either Paxos shipping something
 * (re-pin after reading it) or an issuer-key compromise, and both need a human
 * reading the program, not an automatic pause on the money-out path (ADR 0002).
 *
 * The pins are keyed by MINT ADDRESS, not by symbol and cluster, because the
 * same symbol is a different mint per cluster with different Paxos keys, and
 * the test suite asserts that every Token-2022 mint in
 * `EARN_DEPOSIT_TOKEN_SYMBOLS` on either cluster has a pin, so adding a
 * Token-2022 stablecoin to Earn without pinning it fails CI rather than
 * shipping unmonitored.
 */

import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { support, type TokenMovementRefusal } from "@sdp/solana/token-movement";
import { decodeTokenTerms, TokenTermsError } from "@sdp/solana/token-terms";
import { EARN_DEPOSIT_TOKEN_SYMBOLS, type EarnDepositTokenSymbol } from "@sdp/types/earn";
import {
  type SolanaCluster,
  SPL_TOKEN_PROGRAMS,
  WELL_KNOWN_TOKENS,
} from "@sdp/types/well-known-tokens";
import {
  address,
  assertAccountExists,
  type EncodedAccount,
  fetchEncodedAccounts,
} from "@solana/kit";
import { SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import { decodeMint, isExtension, type Mint } from "@solana-program/token-2022";
import { isEarnEnabled } from "@/lib/feature-flags";
import { getLogger } from "@/runtime/logger";
import { describeError, logEvent } from "@/runtime/money-path-events";
import type { Env } from "@/types/env";

export const EARN_DEPOSIT_MINT_DRIFT_EVENT = "sdp_api_earn_deposit_mint_drift";

/**
 * The guard could not read a cluster at all (no managed RPC pool for it), so drift on that
 * cluster cannot alert. Logged at error wherever Earn is enabled: a silent skip is exactly how a
 * mainnet hook change would go unseen.
 */
export const EARN_DEPOSIT_MINT_GUARD_SKIPPED_EVENT = "sdp_api_earn_deposit_mint_guard_skipped";

/** Deadline for the guard's one batched mint read per pass. */
const DEPOSIT_MINT_READ_TIMEOUT_MS = 10_000;

/** The extension state a Token-2022 deposit mint is expected to hold. */
export interface PinnedToken2022MintState {
  /** `transferHook.programId`; null means the extension exists with no program set. */
  transferHookProgram: string | null;
  /** `transferHook.authority`; null means the hook is immutable. */
  transferHookAuthority: string | null;
  /** `permanentDelegate.delegate`. */
  permanentDelegate: string | null;
}

/**
 * Observed on chain 2026-09-15 with `getAccountInfo(jsonParsed)`. Every mint
 * carries the transferHook extension with NO program set and the permanent
 * delegate pointing at an issuer key. Re-verify against chain before editing
 * (`pnpm check:well-known-mints` covers the address, not these fields).
 */
export const PINNED_TOKEN_2022_DEPOSIT_MINTS: Readonly<Record<string, PinnedToken2022MintState>> = {
  // PYUSD, mainnet-beta
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": {
    transferHookProgram: null,
    transferHookAuthority: "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk",
    permanentDelegate: "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk",
  },
  // USDG, mainnet-beta
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": {
    transferHookProgram: null,
    transferHookAuthority: "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk",
    permanentDelegate: "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk",
  },
  // PYUSD, devnet (Paxos sandbox keys)
  CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM: {
    transferHookProgram: null,
    transferHookAuthority: "G8ENSYKVGPbRTbcN1BxXuRMYeCq13271UjCUrrpZTJ4X",
    permanentDelegate: "DFWDTsWsyGgFLbVARTS92wHDKK2hwTUNk71uPM3mf16S",
  },
  // USDG, devnet (Paxos sandbox keys)
  "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7": {
    transferHookProgram: null,
    transferHookAuthority: "DFWDTsWsyGgFLbVARTS92wHDKK2hwTUNk71uPM3mf16S",
    permanentDelegate: "DFWDTsWsyGgFLbVARTS92wHDKK2hwTUNk71uPM3mf16S",
  },
};

export interface Token2022DepositMint {
  symbol: EarnDepositTokenSymbol;
  mint: string;
}

/** Every Token-2022 mint among Earn's deposit tokens that is deployed on `cluster`. */
export function token2022DepositMints(cluster: SolanaCluster): Token2022DepositMint[] {
  const mints: Token2022DepositMint[] = [];
  for (const symbol of EARN_DEPOSIT_TOKEN_SYMBOLS) {
    const token = WELL_KNOWN_TOKENS[symbol];
    if (token.tokenProgram !== "token-2022") continue;
    const deployment: { readonly [K in SolanaCluster]?: { address: string } } = token.mints;
    const mint = deployment[cluster];
    if (mint) mints.push({ symbol, mint: mint.address });
  }
  return mints;
}

type MintDriftField =
  | "owner"
  | "transfer_hook_extension"
  | "transfer_hook_program"
  | "transfer_hook_authority"
  | "permanent_delegate"
  | "earn_support";

export interface MintDrift {
  field: MintDriftField;
  expected: string | null;
  actual: string | null;
}

/** A deposit mint as one read saw it, reduced to the fields pinned and the Earn row's answer. */
export interface ObservedMintState {
  owner: string;
  /** Undefined when the mint has no transferHook extension at all. */
  transferHook?: { programId: string | null; authority: string | null };
  permanentDelegate: string | null;
  /** The Earn row's first refusal under the mint's Token Terms; null when Earn moves it. */
  earnRefusal: TokenMovementRefusal | null;
}

/**
 * Reduce a base64 mint account, read with the Clock, to the pinned fields and
 * the Earn row's answer; null when it does not decode as a mint SDP can move.
 */
export function observeMintState(
  mint: EncodedAccount,
  clock: EncodedAccount
): ObservedMintState | null {
  let decoded: Mint;
  try {
    decoded = decodeMint(mint).data;
  } catch {
    return null;
  }
  let terms: ReturnType<typeof decodeTokenTerms>;
  try {
    terms = decodeTokenTerms({ kind: "mint", mint: mint.address }, { mint, clock });
  } catch (error) {
    if (error instanceof TokenTermsError) {
      return null;
    }
    throw error;
  }
  // A mint without extensions has no TLV region.
  const extensions = decoded.extensions.__option === "Some" ? decoded.extensions.value : [];
  const hasHook = extensions.some((extension) => isExtension("TransferHook", extension));
  const decision = support(terms, "earn");
  return {
    owner: mint.programAddress,
    transferHook: hasHook
      ? { programId: terms.transferHookProgram, authority: terms.transferHookAuthority }
      : undefined,
    permanentDelegate: terms.permanentDelegate,
    earnRefusal: decision.supported ? null : decision.refusal,
  };
}

/** Every pinned field whose observed value differs. Pure, so the alert path is unit-testable. */
export function detectMintDrift(
  pinned: PinnedToken2022MintState,
  observed: ObservedMintState
): MintDrift[] {
  const drift: MintDrift[] = [];
  const token2022 = SPL_TOKEN_PROGRAMS["token-2022"];
  if (observed.owner !== token2022) {
    drift.push({ field: "owner", expected: token2022, actual: observed.owner });
  }
  if (!observed.transferHook) {
    drift.push({ field: "transfer_hook_extension", expected: "present", actual: null });
  } else {
    if (observed.transferHook.programId !== pinned.transferHookProgram) {
      drift.push({
        field: "transfer_hook_program",
        expected: pinned.transferHookProgram,
        actual: observed.transferHook.programId,
      });
    }
    if (observed.transferHook.authority !== pinned.transferHookAuthority) {
      drift.push({
        field: "transfer_hook_authority",
        expected: pinned.transferHookAuthority,
        actual: observed.transferHook.authority,
      });
    }
  }
  if (observed.permanentDelegate !== pinned.permanentDelegate) {
    drift.push({
      field: "permanent_delegate",
      expected: pinned.permanentDelegate,
      actual: observed.permanentDelegate,
    });
  }
  if (observed.earnRefusal !== null) {
    drift.push({ field: "earn_support", expected: "supported", actual: observed.earnRefusal });
  }
  return drift;
}

/**
 * Error wherever Earn is enabled, and wherever that cannot be read either, so
 * the skip can never pass for routine where the guard was supposed to run.
 */
function skipLevel(env: Env): "error" | "info" {
  try {
    return isEarnEnabled(env) ? "error" : "info";
  } catch {
    return "error";
  }
}

/**
 * Read every Token-2022 deposit mint on the open cluster scope's cluster and
 * report drift from its pin.
 *
 * Never throws and never blocks the pass that called it. One
 * `getMultipleAccounts` through `createClusterRpc()` reads every pinned mint of
 * the cluster from its managed pool, whose genesis guard proves the chain. A cluster with no managed pool is
 * a skip the guard cannot honestly call quiet: it logs
 * `EARN_DEPOSIT_MINT_GUARD_SKIPPED_EVENT` at error where Earn is enabled. A read
 * that fails is a warning, not an alert, because an RPC outage is already
 * covered elsewhere and paging on it here would teach people to ignore the event
 * that matters.
 *
 * Returns the number of drift events emitted, for the caller's summary log.
 */
export async function guardDepositMints(env: Env): Promise<number> {
  const { cluster } = currentClusterScope();
  const mints = token2022DepositMints(cluster).flatMap((entry) => {
    const pinned = PINNED_TOKEN_2022_DEPOSIT_MINTS[entry.mint];
    if (pinned) return [{ ...entry, pinned }];
    // The unit suite refuses this state; at runtime it is a warning so a
    // stale build cannot page on a code omission.
    getLogger().warn({ cluster, ...entry }, "guardDepositMints: mint has no pinned state");
    return [];
  });
  if (mints.length === 0) return 0;

  let rpc: SolanaRpc;
  try {
    rpc = createClusterRpc();
  } catch (err) {
    logEvent(skipLevel(env), {
      event: EARN_DEPOSIT_MINT_GUARD_SKIPPED_EVENT,
      cluster,
      ...describeError(err),
      error_message: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  // One read for every deposit mint of the cluster and the Clock their terms
  // are decoded at.
  let accounts: Awaited<ReturnType<typeof fetchEncodedAccounts>>;
  try {
    accounts = await fetchEncodedAccounts(
      rpc,
      [...mints.map(({ mint }) => address(mint)), SYSVAR_CLOCK_ADDRESS],
      { abortSignal: AbortSignal.timeout(DEPOSIT_MINT_READ_TIMEOUT_MS) }
    );
  } catch (err) {
    getLogger().warn(
      { cluster, error: err instanceof Error ? err.message : String(err) },
      "guardDepositMints: mint read failed"
    );
    return 0;
  }
  const clock = accounts[mints.length];
  // The Clock sysvar always exists; a node answering otherwise fails like any read.
  assertAccountExists(clock);

  let emitted = 0;
  for (const [index, { symbol, mint, pinned }] of mints.entries()) {
    const account = accounts[index];
    const observed = account.exists ? observeMintState(account, clock) : null;
    if (!observed) {
      getLogger().warn(
        { cluster, symbol, mint },
        "guardDepositMints: mint did not parse as a mint"
      );
      continue;
    }

    for (const drift of detectMintDrift(pinned, observed)) {
      emitted += 1;
      logEvent("error", {
        event: EARN_DEPOSIT_MINT_DRIFT_EVENT,
        cluster,
        symbol,
        mint,
        field: drift.field,
        expected: drift.expected,
        actual: drift.actual,
      });
    }
  }
  return emitted;
}
