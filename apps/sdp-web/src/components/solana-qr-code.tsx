"use client";

import { SkeletonBlock } from "@sdp/ui/skeleton-block";
import { useEffect, useRef, useState } from "react";
import { QR_DRAW_SIZE, solanaQrOptions } from "@/lib/solana-qr";

/**
 * A Solana-styled QR code for a payment link, drawn in the browser: the one code every pay link
 * shows, on the public pay page and wherever the dashboard shares the link. The library loads
 * after the page, so a skeleton holds the square until the code is drawn rather than leaving
 * it blank.
 *
 * @param props - What to encode and how big.
 * @param props.url - The link the code opens.
 * @param props.size - Its displayed width and height in px.
 * @param props.label - Its accessible name.
 * @returns The code.
 */
export function SolanaQrCode({ url, size, label }: { url: string; size: number; label: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The url last drawn, so a changed url shows the skeleton until its own code is in.
  const [drawnUrl, setDrawnUrl] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    let active = true;
    void import("@solana/qr-code-styling").then(({ default: QRCodeStyling }) => {
      if (!active) return;
      const qr = new QRCodeStyling(solanaQrOptions(url, QR_DRAW_SIZE));
      container.replaceChildren();
      qr.append(container);
      // The library sizes its svg by width and height alone; a viewBox lets CSS scale it.
      const svg = container.querySelector("svg");
      if (svg === null) throw new Error("The QR code library drew no svg");
      svg.setAttribute("viewBox", `0 0 ${QR_DRAW_SIZE} ${QR_DRAW_SIZE}`);
      setDrawnUrl(url);
    });

    return () => {
      active = false;
      container.replaceChildren();
    };
  }, [url]);

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <div
        ref={containerRef}
        role="img"
        aria-label={label}
        className="size-full [&_svg]:size-full"
      />
      {/* The code always sits on white, whatever the theme, so its skeleton is a grey on white. */}
      {drawnUrl === url ? null : (
        <SkeletonBlock className="absolute inset-0 rounded-xs bg-black/10" />
      )}
    </div>
  );
}
