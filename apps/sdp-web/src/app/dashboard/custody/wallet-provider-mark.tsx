"use client";

import { KeyRound } from "lucide-react";
import Image from "next/image";
import type { KnownCustodyProvider } from "@/app/dashboard/custody/provider-catalog";
import { formatCustodyProviderName } from "@/app/dashboard/custody/provider-catalog";

const PROVIDER_LOGOS: Partial<
  Record<
    KnownCustodyProvider,
    {
      src: string;
      backgroundClassName: string;
      paddingClassName: string;
    }
  >
> = {
  privy: {
    src: "/provider-logos/privy.png",
    backgroundClassName: "bg-[white]",
    paddingClassName: "p-2",
  },
  fireblocks: {
    src: "/provider-logos/fireblocks.svg",
    backgroundClassName: "bg-[white]",
    paddingClassName: "p-2.5",
  },
  coinbase_cdp: {
    src: "/provider-logos/coinbase-cdp.png",
    backgroundClassName: "bg-[white]",
    paddingClassName: "p-1.5",
  },
  para: {
    src: "/provider-logos/para.svg",
    backgroundClassName: "bg-[white]",
    paddingClassName: "p-2",
  },
  turnkey: {
    src: "/provider-logos/turnkey.svg",
    backgroundClassName: "bg-[white]",
    paddingClassName: "p-2.5",
  },
  dfns: {
    src: "/provider-logos/dfns.svg",
    backgroundClassName: "bg-[white]",
    paddingClassName: "p-1.5",
  },
  anchorage: {
    src: "/provider-logos/anchorage.svg",
    // The artwork is white-only. bg-primary flips to near-white in dark mode
    // and swallowed the logo, so the chip pins the dark it had in light mode.
    backgroundClassName: "bg-[#1c1c1d]",
    paddingClassName: "p-2.5",
  },
  utila: {
    src: "/provider-logos/utila.svg",
    backgroundClassName: "bg-[white]",
    paddingClassName: "p-2",
  },
  ibm_haven: {
    src: "/provider-logos/ibm-haven.svg",
    backgroundClassName: "bg-[white]",
    paddingClassName: "p-1.5",
  },
};

interface WalletProviderMarkProps {
  provider?: KnownCustodyProvider | null;
  /**
   * `nav`, `row` and `page` are the refresh design's round marks: a sidebar pin, a card or list
   * row, and the 48px mark beside a wallet page's title.
   */
  size?: "nav" | "xs" | "sm" | "row" | "md" | "page";
}

const MARK_SIZES = {
  nav: { box: "size-5 rounded-full", image: "20px", icon: 11, padding: "p-0.5" },
  xs: { box: "h-6 w-6 rounded-md", image: "24px", icon: 14, padding: null },
  sm: { box: "h-7 w-7 rounded-md", image: "28px", icon: 16, padding: null },
  row: { box: "size-8 rounded-full", image: "32px", icon: 16, padding: "p-1.5" },
  md: { box: "h-12 w-12 rounded-2xl", image: "48px", icon: 22, padding: null },
  page: { box: "size-12 rounded-full", image: "48px", icon: 22, padding: "p-2.5" },
} as const;

export function WalletProviderMark({ provider, size = "md" }: WalletProviderMarkProps) {
  const logo = provider ? PROVIDER_LOGOS[provider] : undefined;
  const { box: dimensionClass, image: imageSizes, icon: iconSize, padding } = MARK_SIZES[size];

  return (
    <div
      className={[
        "inline-flex shrink-0 items-center justify-center overflow-hidden border border-border-subtle",
        logo?.backgroundClassName ?? "bg-fill-subtle",
        dimensionClass,
      ].join(" ")}
      title={provider ? formatCustodyProviderName(provider) : undefined}
      aria-hidden="true"
    >
      {logo ? (
        <div className={["relative h-full w-full", padding ?? logo.paddingClassName].join(" ")}>
          <Image src={logo.src} alt="" fill sizes={imageSizes} className="object-contain" />
        </div>
      ) : (
        <KeyRound size={iconSize} className="text-secondary" />
      )}
    </div>
  );
}
