import type { CustodyProvider } from "@sdp/types/custody";
import type { ComplianceProviderId, RampProviderId } from "@sdp/types/provider-access";
import type { ManagedRpcProvider } from "@sdp/types/rpc";
import { cn } from "@sdp/ui/cn";
import { KeyRoundIcon } from "lucide-react";
import Image from "next/image";

export interface BrandMark {
  logo: string;
  background: string;
  /** Light backgrounds take a hairline ring so the circle still reads on the page. */
  ringed: boolean;
}

export const CUSTODY_BRAND_MARKS = {
  local: null,
  anchorage: { logo: "/provider-logos/brand/anchorage.png", background: "#0f0f13", ringed: false },
  coinbase_cdp: { logo: "/provider-logos/brand/coinbase.png", background: "#ffffff", ringed: true },
  dfns: { logo: "/provider-logos/brand/dfns.svg", background: "#f0f1f4", ringed: true },
  fireblocks: {
    logo: "/provider-logos/brand/fireblocks.png",
    background: "#1a2148",
    ringed: false,
  },
  ibm_haven: { logo: "/provider-logos/brand/ibm.png", background: "#0f0f13", ringed: false },
  para: { logo: "/provider-logos/brand/para.png", background: "#ff5504", ringed: false },
  privy: { logo: "/provider-logos/brand/privy.png", background: "#010110", ringed: false },
  turnkey: { logo: "/provider-logos/brand/turnkey.png", background: "#050a0b", ringed: false },
  utila: { logo: "/provider-logos/brand/utila.png", background: "#0f0f13", ringed: false },
} as const satisfies Record<CustodyProvider, BrandMark | null>;

export const RPC_BRAND_MARKS = {
  alchemy: { logo: "/provider-logos/brand/alchemy.svg", background: "#363ff9", ringed: false },
  helius: { logo: "/provider-logos/brand/helius.svg", background: "#0f0f13", ringed: false },
  nodit: { logo: "/provider-logos/brand/nodit.png", background: "#00d179", ringed: false },
  quicknode: { logo: "/provider-logos/brand/quicknode.png", background: "#6cff75", ringed: true },
  triton: { logo: "/provider-logos/brand/triton.png", background: "#1e1e1e", ringed: false },
  validationcloud: {
    logo: "/provider-logos/brand/validationcloud.png",
    background: "#000000",
    ringed: false,
  },
} as const satisfies Record<Exclude<ManagedRpcProvider, "default">, BrandMark>;

export const RAMP_BRAND_MARKS = {
  moonpay: { logo: "/provider-logos/brand/moonpay.png", background: "#ffffff", ringed: true },
  stripe: { logo: "/provider-logos/brand/stripe.svg", background: "#533afd", ringed: false },
} as const satisfies Record<RampProviderId, BrandMark>;

export const COMPLIANCE_BRAND_MARKS = {
  chainalysis: {
    logo: "/provider-logos/brand/chainalysis.svg",
    background: "#fffdfc",
    ringed: true,
  },
  elliptic: { logo: "/provider-logos/brand/elliptic.svg", background: "#0f0f13", ringed: false },
  range: { logo: "/provider-logos/brand/range.svg", background: "#22533e", ringed: false },
  trm: { logo: "/provider-logos/brand/trm.svg", background: "#0f0f13", ringed: false },
} as const satisfies Record<ComplianceProviderId, BrandMark>;

const BRAND_MARK_SIZES = {
  list: { box: "size-10", logo: 24 },
  page: { box: "size-12", logo: 28 },
} as const;

/** A provider's round brand mark: its logo centred on its brand colour. */
export function ProviderBrandMark({
  mark,
  size,
}: {
  mark: BrandMark | null;
  size: keyof typeof BRAND_MARK_SIZES;
}) {
  const { box, logo } = BRAND_MARK_SIZES[size];
  const markClass = cn(
    "relative inline-flex shrink-0 items-center justify-center rounded-full",
    box
  );
  if (mark === null) {
    return (
      <span aria-hidden className={cn(markClass, "bg-fill-strong")}>
        <KeyRoundIcon className="size-5 text-secondary" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(markClass, mark.ringed && "shadow-[inset_0_0_0_1px_rgba(15,15,19,0.1)]")}
      style={{ backgroundColor: mark.background }}
    >
      <Image src={mark.logo} alt="" width={logo} height={logo} className="object-contain" />
    </span>
  );
}
