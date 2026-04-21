"use client";

import Image from "next/image";
import type { KnownCustodyProvider } from "@/app/dashboard/custody/provider-catalog";
import { formatCustodyProviderName } from "@/app/dashboard/custody/provider-catalog";

const PROVIDER_LOGOS: Record<
  KnownCustodyProvider,
  {
    src: string;
    backgroundClassName: string;
    paddingClassName: string;
  }
> = {
  privy: {
    src: "/provider-logos/privy.png",
    backgroundClassName: "bg-white",
    paddingClassName: "p-2",
  },
  fireblocks: {
    src: "/provider-logos/fireblocks.svg",
    backgroundClassName: "bg-white",
    paddingClassName: "p-2.5",
  },
  coinbase_cdp: {
    src: "/provider-logos/coinbase-cdp.png",
    backgroundClassName: "bg-white",
    paddingClassName: "p-1.5",
  },
  para: {
    src: "/provider-logos/para.svg",
    backgroundClassName: "bg-white",
    paddingClassName: "p-2",
  },
  turnkey: {
    src: "/provider-logos/turnkey.svg",
    backgroundClassName: "bg-white",
    paddingClassName: "p-2.5",
  },
  dfns: {
    src: "/provider-logos/dfns.svg",
    backgroundClassName: "bg-white",
    paddingClassName: "p-1.5",
  },
  anchorage: {
    src: "/provider-logos/anchorage.svg",
    backgroundClassName: "bg-[#111111]",
    paddingClassName: "p-2.5",
  },
};

interface WalletProviderMarkProps {
  provider: KnownCustodyProvider;
  size?: "xs" | "sm" | "md";
}

export function WalletProviderMark({ provider, size = "md" }: WalletProviderMarkProps) {
  const logo = PROVIDER_LOGOS[provider];
  const dimensionClass =
    size === "xs"
      ? "h-6 w-6 rounded-md"
      : size === "sm"
        ? "h-7 w-7 rounded-md"
        : "h-12 w-12 rounded-2xl";
  const imageSizes = size === "xs" ? "24px" : size === "sm" ? "28px" : "48px";

  return (
    <div
      className={[
        "inline-flex items-center justify-center overflow-hidden border border-[rgba(28,28,29,0.08)]",
        logo.backgroundClassName,
        dimensionClass,
      ].join(" ")}
      title={formatCustodyProviderName(provider)}
      aria-hidden="true"
    >
      <div className={["relative h-full w-full", logo.paddingClassName].join(" ")}>
        <Image src={logo.src} alt="" fill sizes={imageSizes} className="object-contain" />
      </div>
    </div>
  );
}
