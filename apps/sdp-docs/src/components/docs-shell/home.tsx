import type { CustodyProvider } from "@sdp/types/custody";
import { CUSTODY_PROVIDERS } from "@sdp/types/custody";
import { ORGANIZATION_RPC_PROVIDERS, type OrganizationRpcProvider } from "@sdp/types/organizations";
import {
  COMPLIANCE_PROVIDERS,
  type ComplianceProviderId,
  RAMP_PROVIDERS,
  type RampProviderId,
} from "@sdp/types/provider-access";
import { isCustodyProviderInReleaseChannel } from "@sdp/types/release-channels";
import Image from "next/image";
import Link from "next/link";
import { isModulePublished, publicSurface } from "@/lib/release-channel";

type Partner = { name: string; logo: string };

const CUSTODY_PARTNERS = {
  local: null,
  fireblocks: { name: "Fireblocks", logo: "fireblocks" },
  privy: { name: "Privy", logo: "privy" },
  coinbase_cdp: { name: "Coinbase CDP", logo: "coinbase" },
  para: { name: "Para", logo: "para" },
  turnkey: { name: "Turnkey", logo: "turnkey" },
  dfns: { name: "DFNS", logo: "dfns" },
  ibm_haven: { name: "IBM Haven", logo: "ibm-haven" },
  anchorage: { name: "Anchorage Digital", logo: "anchorage" },
  utila: { name: "Utila", logo: "utila" },
} as const satisfies Record<CustodyProvider, Partner | null>;

const COMPLIANCE_PARTNERS = {
  range: { name: "Range", logo: "range" },
  elliptic: { name: "Elliptic", logo: "elliptic" },
  trm: { name: "TRM Labs", logo: "trm" },
  chainalysis: { name: "Chainalysis", logo: "chainalysis" },
} as const satisfies Record<ComplianceProviderId, Partner>;

const RAMP_PARTNERS = {
  moonpay: { name: "MoonPay", logo: "moonpay" },
  stripe: { name: "Stripe", logo: "stripe" },
} as const satisfies Record<RampProviderId, Partner>;
const PUBLISHED_RAMP_PROVIDERS = new Set(publicSurface.rampProviders);

const RPC_PARTNERS = {
  default: null,
  alchemy: { name: "Alchemy", logo: "alchemy" },
  helius: { name: "Helius", logo: "helius" },
  nodit: { name: "Nodit", logo: "nodit" },
  quicknode: { name: "QuickNode", logo: "quicknode" },
  triton: { name: "Triton", logo: "triton" },
  validationcloud: { name: "Validation Cloud", logo: "validation-cloud" },
} as const satisfies Record<OrganizationRpcProvider, Partner | null>;

function PartnerRow({ label, partners }: { label: string; partners: readonly Partner[] }) {
  if (partners.length === 0) return null;

  return (
    <li className="launch-home-partner-row">
      <h3>{label}</h3>
      <ul className="launch-home-partner-logos" aria-label={`${label} partners`}>
        {partners.map((partner) => (
          <li key={partner.logo} className="launch-home-partner-logo">
            <Image
              src={`/images/partners/${partner.logo}.svg`}
              alt={partner.name}
              width={132}
              height={32}
            />
          </li>
        ))}
      </ul>
    </li>
  );
}

const MODEL_ITEMS = [
  { label: "Project", detail: "One environment for your keys and wallets." },
  { label: "API", detail: "One interface for every request." },
  { label: "Providers", detail: "The services you choose behind it." },
] as const;

const START_STEPS = [
  {
    number: "01",
    title: "Set up your workspace",
    description: "Create an organization and sandbox project.",
    href: "/docs/guides/setup-organization",
  },
  {
    number: "02",
    title: "Create a wallet",
    description: "Choose a provider and create a wallet for signing.",
    href: "/docs/guides/setup-wallets",
  },
  {
    number: "03",
    title: "Create an API key",
    description: "Grant only the actions your integration needs.",
    href: "/docs/developing-with-sdp/manage-api-keys",
  },
  {
    number: "04",
    title: "Send a payment",
    description: "Make a request in your sandbox project.",
    href: "/docs/payments/send-basic-payment",
  },
] as const;

const NEXT_PATHS = [
  {
    title: "API reference",
    description: "Endpoints, requests, and responses.",
    href: "/docs/reference/api",
  },
  {
    title: "Core concepts",
    description: "Authentication, environments, and conventions.",
    href: "/docs/developing-with-sdp",
  },
  {
    title: "Self-hosting",
    description: "Run SDP in your own environment.",
    href: "/docs/self-hosting",
  },
] as const;

/** A concise start page with one product model and one route to first success. */
export function DocsHome() {
  const custodyPartners = CUSTODY_PROVIDERS.filter(
    (provider) =>
      isCustodyProviderInReleaseChannel(publicSurface.releaseChannel, provider, "managed") ||
      isCustodyProviderInReleaseChannel(publicSurface.releaseChannel, provider, "byok")
  ).flatMap((provider) => {
    const partner = CUSTODY_PARTNERS[provider];
    return partner ? [partner] : [];
  });
  const compliancePartners = isModulePublished("compliance")
    ? COMPLIANCE_PROVIDERS.map((provider) => COMPLIANCE_PARTNERS[provider])
    : [];
  const rampPartners = RAMP_PROVIDERS.filter((provider) =>
    PUBLISHED_RAMP_PROVIDERS.has(provider)
  ).map((provider) => RAMP_PARTNERS[provider]);
  const rpcPartners = ORGANIZATION_RPC_PROVIDERS.flatMap((provider) => {
    const partner = RPC_PARTNERS[provider];
    return partner ? [partner] : [];
  });

  return (
    <div className="launch-home">
      <div className="launch-home-actions">
        <Link href="/docs/guides/setup-organization" className="launch-home-cta-primary">
          Create a project
        </Link>
        <Link href="/docs/introduction" className="launch-home-cta-secondary">
          Learn more about SDP
        </Link>
      </div>

      <section className="launch-home-system" aria-labelledby="launch-home-system-title">
        <div className="launch-home-section-heading">
          <span className="launch-home-eyebrow">The model</span>
          <h2 id="launch-home-system-title">One project connects everything.</h2>
          <p>
            Configure a project in the dashboard, then use the REST API to build with your chosen
            providers.
          </p>
        </div>
        <ul className="launch-home-model">
          {MODEL_ITEMS.map((item) => (
            <li key={item.label}>
              <span className="launch-home-model-copy">
                <strong>{item.label}</strong>
                <span>{item.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="launch-home-section" aria-labelledby="launch-home-steps-title">
        <div className="launch-home-section-heading">
          <span className="launch-home-eyebrow">Start here</span>
          <h2 id="launch-home-steps-title">From setup to first request.</h2>
        </div>
        <ol className="launch-home-steps">
          {START_STEPS.map((step) => (
            <li key={step.number}>
              <Link href={step.href} className="launch-home-step">
                <span className="launch-home-step-number">{step.number}</span>
                <span className="launch-home-step-copy">
                  <strong>{step.title}</strong>
                  <span>{step.description}</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </section>

      <section className="launch-home-section" aria-labelledby="launch-home-partners-title">
        <div className="launch-home-section-heading">
          <span className="launch-home-eyebrow">Ecosystem</span>
          <h2 id="launch-home-partners-title">Supported partners.</h2>
          <p>Provider availability depends on your project and environment.</p>
        </div>
        <ul className="launch-home-partner-groups">
          <PartnerRow label="Custody" partners={custodyPartners} />
          <PartnerRow label="Ramps" partners={rampPartners} />
          <PartnerRow label="Compliance" partners={compliancePartners} />
          <PartnerRow label="RPC" partners={rpcPartners} />
        </ul>
      </section>

      <section className="launch-home-section" aria-labelledby="launch-home-next-title">
        <div className="launch-home-section-heading">
          <span className="launch-home-eyebrow">Go deeper</span>
          <h2 id="launch-home-next-title">Find what you need.</h2>
        </div>
        <div className="launch-home-next">
          {NEXT_PATHS.map((path) => (
            <Link key={path.href} href={path.href} className="launch-home-next-link">
              <span>
                <strong>{path.title}</strong>
                <span>{path.description}</span>
              </span>
            </Link>
          ))}
        </div>
        <p className="launch-home-ai-link">
          Building with an agent?{" "}
          <Link href="/docs/reference/docs-for-ai">Use the SDP docs skill</Link>.
        </p>
      </section>
    </div>
  );
}
