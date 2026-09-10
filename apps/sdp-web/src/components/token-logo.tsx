"use client";

import { useState } from "react";
import { tokenMarkInitial } from "@/app/dashboard/issuance/issuance-token-fields";
import { cn } from "@/lib/utils";

/**
 * The identity mark for a token: the issuer's artwork, or a quiet monogram
 * standing in for artwork they haven't supplied. The artwork is a plain `img`
 * because it is user-supplied — next/image cannot be configured for arbitrary
 * hosts — and it falls back to the monogram when it fails to load, so a broken
 * URL never leaves an empty circle.
 *
 * @param imageUrl - The issuer's artwork URL, or null for the monogram.
 * @param symbol - The token's display symbol; its first character is the monogram.
 * @param className - The mark's box size as layout tokens, e.g. `h-11 w-11` on
 *   the asset header, `h-9 w-9` on a leg card. The image and monogram fill it.
 */
export function TokenLogo({
  imageUrl,
  symbol,
  className,
}: {
  imageUrl: string | null;
  symbol: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div
      aria-hidden="true"
      className={cn("shrink-0 overflow-hidden rounded-full border border-border-subtle", className)}
    >
      {imageUrl && !failed ? (
        // biome-ignore lint/performance/noImgElement: user-supplied external logo URL; next/image can't be configured for arbitrary hosts here.
        <img
          src={imageUrl}
          alt=""
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-fill-subtle text-sm font-semibold text-tertiary">
          {tokenMarkInitial(symbol)}
        </div>
      )}
    </div>
  );
}
