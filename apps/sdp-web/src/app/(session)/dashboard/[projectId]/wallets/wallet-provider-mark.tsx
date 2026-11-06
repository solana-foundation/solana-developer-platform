"use client";

import { KeyRound } from "lucide-react";
import Image from "next/image";
import type { KnownCustodyProvider } from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import { formatCustodyProviderName } from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import { CUSTODY_BRAND_MARKS } from "@/lib/provider-brand-marks";

interface WalletProviderMarkProps {
  provider?: KnownCustodyProvider | null;
  /**
   * `nav`, `row` and `page` are the design's round marks: a sidebar pin, a card or list
   * row, and the 48px mark beside a wallet page's title.
   */
  size?: "nav" | "xs" | "sm" | "row" | "md" | "page";
}

const MARK_SIZES = {
  nav: { box: "size-5 rounded-full", image: "20px", icon: 11, padding: "p-1" },
  xs: { box: "h-6 w-6 rounded-md", image: "24px", icon: 14, padding: "p-1" },
  sm: { box: "h-7 w-7 rounded-md", image: "28px", icon: 16, padding: "p-1.5" },
  row: { box: "size-8 rounded-full", image: "32px", icon: 16, padding: "p-1.5" },
  md: { box: "h-12 w-12 rounded-2xl", image: "48px", icon: 22, padding: "p-2.5" },
  page: { box: "size-12 rounded-full", image: "48px", icon: 22, padding: "p-2.5" },
} as const;

export function WalletProviderMark({ provider, size = "md" }: WalletProviderMarkProps) {
  const mark = provider ? CUSTODY_BRAND_MARKS[provider] : null;
  const { box: dimensionClass, image: imageSizes, icon: iconSize, padding } = MARK_SIZES[size];

  return (
    <div
      className={[
        "inline-flex shrink-0 items-center justify-center overflow-hidden",
        mark === null ? "border border-border-subtle bg-fill-subtle" : "",
        mark?.ringed ? "ring-1 ring-border-subtle ring-inset" : "",
        dimensionClass,
      ].join(" ")}
      style={mark === null ? undefined : { backgroundColor: mark.background }}
      title={provider ? formatCustodyProviderName(provider) : undefined}
      aria-hidden="true"
    >
      {mark ? (
        <div className={["relative h-full w-full", padding].join(" ")}>
          <Image src={mark.logo} alt="" fill sizes={imageSizes} className="object-contain" />
        </div>
      ) : (
        <KeyRound size={iconSize} className="text-secondary" />
      )}
    </div>
  );
}
