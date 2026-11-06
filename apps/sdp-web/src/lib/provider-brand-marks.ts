import type { CustodyProvider } from "@sdp/types/custody";
import type { ComplianceProviderId, RampProviderId } from "@sdp/types/provider-access";
import type { ManagedRpcProvider } from "@sdp/types/rpc";

export interface BrandMark {
  logo: string;
  background: string;
}

export const CUSTODY_BRAND_MARKS = {
  local: null,
  anchorage: { logo: "/provider-logos/brand/anchorage.png", background: "#0f0f13" },
  coinbase_cdp: { logo: "/provider-logos/brand/coinbase.png", background: "#ffffff" },
  dfns: { logo: "/provider-logos/brand/dfns.svg", background: "#f0f1f4" },
  fireblocks: {
    logo: "/provider-logos/brand/fireblocks.png",
    background: "#1a2148",
  },
  ibm_haven: { logo: "/provider-logos/brand/ibm.png", background: "#0f0f13" },
  para: { logo: "/provider-logos/brand/para.png", background: "#ff5504" },
  privy: { logo: "/provider-logos/brand/privy.png", background: "#010110" },
  turnkey: { logo: "/provider-logos/brand/turnkey.png", background: "#050a0b" },
  utila: { logo: "/provider-logos/brand/utila.png", background: "#0f0f13" },
} as const satisfies Record<CustodyProvider, BrandMark | null>;

export const RPC_BRAND_MARKS = {
  alchemy: { logo: "/provider-logos/brand/alchemy.svg", background: "#363ff9" },
  helius: { logo: "/provider-logos/brand/helius.svg", background: "#0f0f13" },
  nodit: { logo: "/provider-logos/brand/nodit.png", background: "#00d179" },
  quicknode: { logo: "/provider-logos/brand/quicknode.png", background: "#6cff75" },
  triton: { logo: "/provider-logos/brand/triton.png", background: "#1e1e1e" },
  validationcloud: {
    logo: "/provider-logos/brand/validationcloud.png",
    background: "#000000",
  },
} as const satisfies Record<Exclude<ManagedRpcProvider, "default">, BrandMark>;

export const RAMP_BRAND_MARKS = {
  moonpay: { logo: "/provider-logos/brand/moonpay.png", background: "#ffffff" },
  stripe: { logo: "/provider-logos/brand/stripe.svg", background: "#533afd" },
  hercle: { logo: "/provider-logos/hercle.png", background: "#000000" },
} as const satisfies Record<RampProviderId, BrandMark>;

export const COMPLIANCE_BRAND_MARKS = {
  chainalysis: {
    logo: "/provider-logos/brand/chainalysis.svg",
    background: "#fffdfc",
  },
  elliptic: { logo: "/provider-logos/brand/elliptic.svg", background: "#0f0f13" },
  range: { logo: "/provider-logos/brand/range.svg", background: "#22533e" },
  trm: { logo: "/provider-logos/brand/trm.svg", background: "#0f0f13" },
} as const satisfies Record<ComplianceProviderId, BrandMark>;
