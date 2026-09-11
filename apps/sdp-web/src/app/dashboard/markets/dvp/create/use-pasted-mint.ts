"use client";

/**
 * Resolving a mint somebody pasted, so its leg can take a human amount.
 *
 * A listed token carries its decimals with it. A pasted address carried
 * nothing, so its amount field silently changed meaning to base units — the
 * asset leg asking for `1000000000` beside a cash leg asking for `10`. That is
 * the exact hazard `dvp-amount.ts` was written to remove, reintroduced by the
 * one path where the decimals were not to hand.
 *
 * They were always one account read away. This asks for them.
 *
 * Debounced because it fires while someone is still typing an address, and
 * every keystroke of a 44-character base58 string would otherwise be a request.
 */

import { isAddress } from "@sdp/solana";
import { SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import { useEffect, useState } from "react";
import { useOptionalDashboardWorkspace } from "@/contexts/dashboard-workspace-context";

const DEBOUNCE_MS = 350;

export interface PastedMint {
  decimals: number;
  name: string | null;
  symbol: string | null;
  tokenProgram: string;
  eligible: boolean;
  /** The extension DvP refuses, when this mint is ruled out. */
  blockedBy: string | null;
}

export interface PastedMintState {
  mint: PastedMint | null;
  /**
   * The address this state describes.
   *
   * Carried so a reader can tell whether the metadata belongs to the mint
   * currently typed. Without it, an answer for a PREVIOUS address is
   * indistinguishable from an answer for this one — and the difference is the
   * decimals an amount gets scaled by, which is the difference between sending
   * 1,000 tokens and sending 1,000,000,000 of them.
   */
  address: string;
  loading: boolean;
  /**
   * Set when the address resolved to nothing readable. Distinct from `loading`
   * so the field can say "we could not read that" rather than staying blank.
   */
  notFound: boolean;
}

/**
 * One completed lookup, tagged with the address it answers for.
 *
 * The tag is the whole safety property. An answer is only ever read back when
 * its address still matches what is typed, so a result for a previous mint is
 * unreadable rather than merely stale.
 */
interface PastedMintLookup {
  address: string;
  mint: PastedMint | null;
  notFound: boolean;
}

export function usePastedMint(address: string): PastedMintState {
  const sandbox = useOptionalDashboardWorkspace()?.sdpEnvironment === "sandbox";
  // ONLY the completed lookup is state. Everything the caller sees is worked
  // out below from this plus the current address.
  //
  // The previous version stored the whole exposed shape and invalidated it from
  // inside the effect. That left a window exactly one render wide: between the
  // address changing and the effect running, state still described the OLD
  // mint while claiming the NEW address, and anything reading decimals in that
  // render scaled the amount by the wrong token. Deriving during render closes
  // the window by construction — there is no moment at which the two disagree.
  const [lookup, setLookup] = useState<PastedMintLookup | null>(null);

  const trimmed = address.trim();
  const notAnAddress = !isAddress(trimmed);
  const answered = lookup !== null && lookup.address === trimmed;

  useEffect(() => {
    const wanted = address.trim();
    if (!isAddress(wanted)) {
      return;
    }

    // Aborted on every change, so a slow lookup for an address that has since
    // been edited can never land after a newer one and overwrite it.
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (sandbox) {
        const known = WELL_KNOWN_TOKEN_BY_MINT.get(wanted);
        setLookup({
          address: wanted,
          mint: {
            decimals: known?.decimals ?? 6,
            name: known?.name ?? null,
            symbol: known?.symbol ?? null,
            tokenProgram: known
              ? SPL_TOKEN_PROGRAMS[known.tokenProgram]
              : SPL_TOKEN_PROGRAMS["token-2022"],
            eligible: true,
            blockedBy: null,
          },
          notFound: false,
        });
        return;
      }
      try {
        const response = await fetch(
          `/api/dashboard/markets/dvp/mints/${encodeURIComponent(wanted)}`,
          { signal: controller.signal }
        );
        if (!response.ok) {
          // A 404 is the ordinary answer for a mistyped address, not an error
          // worth shouting about. Anything else is also non-fatal: without a
          // scale the leg simply has no base units and submit stays blocked.
          setLookup({ address: wanted, mint: null, notFound: response.status === 404 });
          return;
        }
        const body = (await response.json()) as { data?: { mint?: PastedMint } };
        const mint = body.data?.mint ?? null;
        setLookup({ address: wanted, mint, notFound: mint === null });
      } catch (error) {
        if ((error as Error)?.name === "AbortError") {
          return;
        }
        setLookup({ address: wanted, mint: null, notFound: false });
      }
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [address, sandbox]);

  return {
    // Never the previous mint's metadata: an unanswered address reads as null.
    mint: answered ? lookup.mint : null,
    address: trimmed,
    // True from the very render the address changes, not one render later.
    loading: !notAnAddress && !answered,
    notFound: answered ? lookup.notFound : false,
  };
}
