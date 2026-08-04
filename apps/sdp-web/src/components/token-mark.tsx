"use client";

import { WELL_KNOWN_TOKEN_BY_MINT, type WellKnownTokenSymbol } from "@sdp/types";
import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * Locally bundled marks for the tokens whose logos come from a stable, first
 * party or long-lived source. Tokens without an entry fall back to a monogram
 * rather than hotlinking a third-party CDN: a custody dashboard should not make
 * requests to arbitrary origins on render, and IPFS and Arweave gateways are
 * not dependable enough to sit in a picker.
 *
 * SVG wherever the mark is published as one. Three are not: JitoSOL and USDG
 * are distributed as PNG by their own issuers (Jito's token-metadata bucket and
 * Paxos respectively), and every vector WBTC mark that could be found is drawn
 * in flat white, which disappears against the white chip these render on.
 */
const TOKEN_LOGOS: Partial<Record<WellKnownTokenSymbol, string>> = {
  SOL: "/token-logos/sol.svg",
  USDC: "/token-logos/usdc.svg",
  USDT: "/token-logos/usdt.svg",
  USDG: "/token-logos/usdg.png",
  PYUSD: "/token-logos/pyusd.svg",
  EURC: "/token-logos/eurc.svg",
  JITOSOL: "/token-logos/jitosol.png",
  MSOL: "/token-logos/msol.svg",
  BSOL: "/token-logos/bsol.svg",
  WBTC: "/token-logos/wbtc.png",
};

/** Monogram tints for tokens without a bundled mark. Keyed by display symbol. */
const MONOGRAM_TINTS: Record<string, string> = {
  USDS: "bg-[#1a1a1a] text-[white]",
  USDY: "bg-[#0b4f4a] text-[white]",
  INF: "bg-[#7c5cff] text-[white]",
  cbBTC: "bg-[#0052ff] text-[white]",
};

const SIZE_STYLES = {
  xs: { box: "size-5", text: "text-[8px]", px: 20 },
  sm: { box: "size-6", text: "text-[9px]", px: 24 },
  md: { box: "size-8", text: "text-[10px]", px: 32 },
} as const;

export type TokenMarkSize = keyof typeof SIZE_STYLES;

interface TokenMarkProps {
  /** Mint address; resolves a well-known token when it matches one. */
  mint?: string | null;
  /** Display symbol, used for the monogram when no logo is bundled. */
  symbol?: string | null;
  size?: TokenMarkSize;
  className?: string;
}

/** Two or three characters read better than a truncated long symbol. */
function toMonogram(symbol: string): string {
  const trimmed = symbol.trim();
  if (trimmed.length <= 4) return trimmed.toUpperCase();
  return trimmed.slice(0, 3).toUpperCase();
}

export function TokenMark({ mint, symbol, size = "sm", className }: TokenMarkProps) {
  const wellKnown = mint ? WELL_KNOWN_TOKEN_BY_MINT.get(mint.trim()) : undefined;
  const displaySymbol = wellKnown?.symbol ?? symbol?.trim() ?? "";

  // The catalogue is keyed by uppercase symbol while `symbol` carries display
  // casing, so resolve the logo through the uppercase form.
  const logo = TOKEN_LOGOS[displaySymbol.toUpperCase() as WellKnownTokenSymbol];

  const { box, text, px } = SIZE_STYLES[size];

  if (logo) {
    return (
      <span
        className={cn(
          "relative inline-flex shrink-0 overflow-hidden rounded-full border border-border-subtle bg-[white]",
          box,
          className
        )}
        aria-hidden="true"
      >
        <Image src={logo} alt="" fill sizes={`${px}px`} className="object-contain" />
      </span>
    );
  }

  const tint = MONOGRAM_TINTS[displaySymbol] ?? "bg-fill-subtle text-secondary";

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border border-border-subtle font-semibold uppercase leading-none tracking-tight",
        box,
        text,
        tint,
        className
      )}
      aria-hidden="true"
    >
      {displaySymbol ? toMonogram(displaySymbol) : "?"}
    </span>
  );
}
