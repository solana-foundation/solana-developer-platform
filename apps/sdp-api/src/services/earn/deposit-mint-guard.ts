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

import { createRpc } from "@sdp/rpc/solana";
import {
  EARN_DEPOSIT_TOKEN_SYMBOLS,
  type EarnDepositTokenSymbol,
  type SolanaCluster,
  SPL_TOKEN_PROGRAMS,
  WELL_KNOWN_TOKENS,
} from "@sdp/types";
import { address } from "@solana/kit";
import { z } from "zod";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import { assertClusterEndpoint, resolveClusterRpcUrl } from "@/services/earn/execution-registry";
import type { Env } from "@/types/env";

export const EARN_DEPOSIT_MINT_DRIFT_EVENT = "sdp_api_earn_deposit_mint_drift";

/** Deadline for one mint read; the whole guard is a handful of these per pass. */
export const DEPOSIT_MINT_READ_TIMEOUT_MS = 10_000;

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

export type MintDriftField =
  | "owner"
  | "transfer_hook_extension"
  | "transfer_hook_program"
  | "transfer_hook_authority"
  | "permanent_delegate";

export interface MintDrift {
  field: MintDriftField;
  expected: string | null;
  actual: string | null;
}

/** What `getAccountInfo(jsonParsed)` returns for a Token-2022 mint, reduced to the fields pinned. */
export interface ObservedMintState {
  owner: string;
  /** Undefined when the mint has no transferHook extension at all. */
  transferHook?: { programId: string | null; authority: string | null };
  permanentDelegate: string | null;
}

const optionalKey = z.string().nullable().optional();

const parsedMintSchema = z.object({
  owner: z.string(),
  data: z.object({
    parsed: z.object({
      type: z.literal("mint"),
      info: z.object({
        extensions: z
          .array(
            z.object({
              extension: z.string(),
              state: z
                .object({
                  programId: optionalKey,
                  authority: optionalKey,
                  delegate: optionalKey,
                })
                .passthrough()
                .optional(),
            })
          )
          .optional(),
      }),
    }),
  }),
});

/** Reduce a jsonParsed mint account to the pinned fields; null when it does not parse as a mint. */
export function observeMintState(accountValue: unknown): ObservedMintState | null {
  const parsed = parsedMintSchema.safeParse(accountValue);
  if (!parsed.success) return null;
  const extensions = parsed.data.data.parsed.info.extensions ?? [];
  const hook = extensions.find((ext) => ext.extension === "transferHook");
  const delegate = extensions.find((ext) => ext.extension === "permanentDelegate");
  return {
    owner: parsed.data.owner,
    transferHook: hook
      ? { programId: hook.state?.programId ?? null, authority: hook.state?.authority ?? null }
      : undefined,
    permanentDelegate: delegate?.state?.delegate ?? null,
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
  return drift;
}

/**
 * Read every Token-2022 deposit mint on `cluster` and report drift from its pin.
 *
 * Never throws and never blocks the pass that called it. A cluster this
 * deployment has no proven RPC for is a quiet skip (a devnet-only deployment
 * has nothing to say about mainnet PYUSD); a read that fails is a warning, not
 * an alert, because an RPC outage is already covered elsewhere and paging on
 * it here would teach people to ignore the event that matters.
 *
 * Returns the number of drift events emitted, for the caller's summary log.
 */
export async function guardDepositMints(env: Env, cluster: SolanaCluster): Promise<number> {
  const mints = token2022DepositMints(cluster);
  if (mints.length === 0) return 0;

  const rpcUrl = resolveClusterRpcUrl(env, cluster);
  try {
    await assertClusterEndpoint(env, cluster, rpcUrl);
  } catch (err) {
    getLogger().info(
      { cluster, error: err instanceof Error ? err.message : String(err) },
      "guardDepositMints: skipped, no proven RPC for this cluster"
    );
    return 0;
  }
  const rpc = createRpc(env, { rpcUrl, requestTimeoutMs: DEPOSIT_MINT_READ_TIMEOUT_MS });

  let emitted = 0;
  for (const { symbol, mint } of mints) {
    const pinned = PINNED_TOKEN_2022_DEPOSIT_MINTS[mint];
    if (!pinned) {
      // The unit suite refuses this state; at runtime it is a warning so a
      // stale build cannot page on a code omission.
      getLogger().warn({ cluster, symbol, mint }, "guardDepositMints: mint has no pinned state");
      continue;
    }

    let observed: ObservedMintState | null;
    try {
      const response = await rpc.getAccountInfo(address(mint), { encoding: "jsonParsed" }).send();
      observed = observeMintState(response.value);
    } catch (err) {
      getLogger().warn(
        { cluster, symbol, mint, error: err instanceof Error ? err.message : String(err) },
        "guardDepositMints: mint read failed"
      );
      continue;
    }
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
