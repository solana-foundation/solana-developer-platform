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

import { useEffect, useState } from "react";

/** Long enough that a partial paste is not worth a request. */
const MIN_ADDRESS_LENGTH = 32;
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

export function usePastedMint(address: string): PastedMintState {
  const [state, setState] = useState<PastedMintState>({
    mint: null,
    address: "",
    loading: false,
    notFound: false,
  });

  useEffect(() => {
    const trimmed = address.trim();
    if (trimmed.length < MIN_ADDRESS_LENGTH) {
      setState({ mint: null, address: trimmed, loading: false, notFound: false });
      return;
    }

    // Invalidated HERE, not inside the debounce. The old answer describes a
    // different mint the instant the address changes, and leaving it in place
    // for the debounce window left the amount being scaled by the previous
    // mint's decimals. Debouncing is about not spamming the request; it was
    // never a reason to keep answering with the wrong token.
    setState({ mint: null, address: trimmed, loading: true, notFound: false });

    // Aborted on every change, so a slow lookup for an address that has since
    // been edited can never land after a newer one and overwrite it.
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/dashboard/markets/dvp/mints/${encodeURIComponent(trimmed)}`,
          { signal: controller.signal }
        );
        if (!response.ok) {
          // A 404 is the ordinary answer for a mistyped address, not an error
          // worth shouting about. Anything else is also non-fatal here: the
          // field falls back to base units, which is what it did before.
          setState({
            mint: null,
            address: trimmed,
            loading: false,
            notFound: response.status === 404,
          });
          return;
        }
        const body = (await response.json()) as { data?: { mint?: PastedMint } };
        const mint = body.data?.mint;
        setState({
          mint: mint ?? null,
          address: trimmed,
          loading: false,
          notFound: !mint,
        });
      } catch (error) {
        if ((error as Error)?.name === "AbortError") {
          return;
        }
        setState({ mint: null, address: trimmed, loading: false, notFound: false });
      }
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [address]);

  return state;
}
