"use client";

import { WELL_KNOWN_TOKEN_BY_MINT, type WellKnownTokenSymbol } from "@sdp/types";
import Image from "next/image";
import { useState } from "react";
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
  /** Issuer-supplied logo URL, used only when the mint is not well-known. */
  logoUrl?: string | null;
  size?: TokenMarkSize;
  className?: string;
}

/** Two or three characters read better than a truncated long symbol. */
function toMonogram(symbol: string): string {
  const trimmed = symbol.trim();
  if (trimmed.length <= 4) return trimmed.toUpperCase();
  return trimmed.slice(0, 3).toUpperCase();
}

/**
 * Resolves a mint to its display symbol and bundled logo. Logos only resolve
 * through mints verified against the well-known registry — a symbol alone
 * must never resolve one, since token names are self-reported and an issued
 * token named "USDC" would otherwise wear Circle's mark.
 *
 * @param mint - Mint address; resolves a well-known token when it matches one.
 * @param symbol - Display symbol fallback for mints outside the registry.
 * @returns The mint's display symbol and bundled logo path.
 */
function resolveMark(
  mint?: string | null,
  symbol?: string | null
): { displaySymbol: string; logo: string | undefined } {
  const wellKnown = mint ? WELL_KNOWN_TOKEN_BY_MINT.get(mint.trim()) : undefined;
  const displaySymbol = wellKnown?.symbol ?? symbol?.trim() ?? "";
  const logo = wellKnown
    ? TOKEN_LOGOS[wellKnown.symbol.toUpperCase() as WellKnownTokenSymbol]
    : undefined;
  return { displaySymbol, logo };
}

export function TokenMark({ mint, symbol, logoUrl, size = "sm", className }: TokenMarkProps) {
  const { displaySymbol, logo } = resolveMark(mint, symbol);
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);

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

  if (logoUrl && failedLogoUrl !== logoUrl) {
    return (
      <span
        className={cn(
          "relative inline-flex shrink-0 overflow-hidden rounded-full border border-border-subtle bg-[white]",
          box,
          className
        )}
        aria-hidden="true"
      >
        {/* biome-ignore lint/performance/noImgElement: issuer-supplied external logo URL; next/image can't be configured for arbitrary hosts. */}
        <img
          src={logoUrl}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setFailedLogoUrl(logoUrl)}
        />
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
