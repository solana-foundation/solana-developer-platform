"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

const SIZES = {
  md: "size-8 text-body",
  lg: "size-9 text-body",
} as const;

/**
 * An issued token's mark as the design draws it: the issuer's logo where one is set and
 * loads, otherwise the first letter of its symbol on a quiet round tile.
 */
export function IssuedTokenMark({
  symbol,
  name,
  logoUrl,
  size = "lg",
  className,
}: {
  symbol: string;
  name?: string;
  logoUrl?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  const letter = (symbol.trim() || name?.trim() || "?").slice(0, 1).toUpperCase();
  const showLogo = Boolean(logoUrl && /^https:\/\//.test(logoUrl) && failedLogoUrl !== logoUrl);

  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-full bg-fill font-medium text-secondary",
        SIZES[size],
        className
      )}
    >
      {showLogo && logoUrl ? (
        // biome-ignore lint/performance/noImgElement: issuer-supplied logo URL; next/image can't be configured for arbitrary hosts.
        <img
          src={logoUrl}
          alt=""
          className="size-full object-cover"
          onError={() => setFailedLogoUrl(logoUrl)}
        />
      ) : (
        letter
      )}
    </span>
  );
}
