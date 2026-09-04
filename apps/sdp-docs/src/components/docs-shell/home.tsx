import {
  ArrowLeftRightIcon,
  ArrowRightIcon,
  BotIcon,
  BracesIcon,
  CircleDollarSignIcon,
  FileTextIcon,
  HandshakeIcon,
  LandmarkIcon,
  LayersIcon,
  LinkIcon,
  type LucideIcon,
  ReceiptTextIcon,
  RepeatIcon,
  ServerIcon,
  ShieldCheckIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { HomePageClass } from "./home-page-class";
import { HOME_SECTIONS } from "./home-sections";
import {
  ArchitectureSketch,
  IssuanceSketch,
  MarketsSketch,
  RampsSketch,
  TransfersSketch,
  WalletsSketch,
} from "./home-sketches";

/**
 * Section heading that doubles as a deep link: the heading carries the id and
 * wraps itself in an anchor to it, so every section label is linkable. The
 * link icon is revealed on hover, after the text.
 */
function SectionHeading({ id, title }: { id: string; title: string }) {
  return (
    <h2 id={id} className="launch-home-section-label">
      <a href={`#${id}`} className="launch-home-heading-anchor">
        <span className="launch-home-heading-anchor-text">{title}</span>
        <LinkIcon size={17} aria-hidden="true" />
      </a>
    </h2>
  );
}

function HomeCardLink({ card }: { card: HomeCard }) {
  const content = (
    <>
      {"graphic" in card ? (
        <div className="launch-home-outcome-sketch">{card.graphic}</div>
      ) : (
        <div className="launch-home-outcome-icon-wrap">
          <card.Icon size={20} aria-hidden="true" />
        </div>
      )}
      <div className="launch-home-outcome-divider" aria-hidden="true" />
      <div className="launch-home-outcome-body">
        <h3 className="launch-home-outcome-title">
          {card.name}
          {card.badge ? <span className="launch-badge">{card.badge}</span> : null}
        </h3>
        <p className="launch-home-outcome-desc">{card.desc}</p>
      </div>
    </>
  );

  if ("disabled" in card) {
    return <div className="launch-home-outcome is-disabled">{content}</div>;
  }

  return (
    <Link href={card.href} className="launch-home-outcome">
      {content}
    </Link>
  );
}

type Partner = { name: string; src: string; h: number };

const PARTNER_ROWS: { category: string; Icon: LucideIcon; partners: Partner[] }[] = [
  {
    category: "Institutional Custody",
    Icon: LandmarkIcon,
    partners: [
      { name: "Privy", h: 22, src: "/docs/images/partners/privy.svg" },
      { name: "Fireblocks", h: 24, src: "/docs/images/partners/fireblocks.svg" },
      { name: "Coinbase CDP", h: 22, src: "/docs/images/partners/coinbase.svg" },
      { name: "Turnkey", h: 22, src: "/docs/images/partners/turnkey.svg" },
      { name: "Anchorage Digital", h: 22, src: "/docs/images/partners/anchorage.svg" },
      { name: "Dfns", h: 20, src: "/docs/images/partners/dfns.svg" },
      { name: "IBM Haven", h: 22, src: "/docs/images/partners/ibm-haven.svg" },
      { name: "Para", h: 20, src: "/docs/images/partners/para.svg" },
      { name: "Utila", h: 20, src: "/docs/images/partners/utila.svg" },
    ],
  },
  {
    category: "Ramps",
    Icon: ArrowLeftRightIcon,
    partners: [
      { name: "MoonPay", h: 24, src: "/docs/images/partners/moonpay.svg" },
      { name: "Lightspark", h: 22, src: "/docs/images/partners/lightspark.svg" },
      { name: "BVNK", h: 18, src: "/docs/images/partners/bvnk.svg" },
      { name: "Coinbase", h: 22, src: "/docs/images/partners/coinbase.svg" },
      { name: "Stripe", h: 30, src: "/docs/images/partners/stripe.svg" },
      { name: "MoneyGram", h: 24, src: "/docs/images/partners/moneygram.svg" },
      { name: "Mural Pay", h: 20, src: "/docs/images/partners/muralpay.svg" },
    ],
  },
  {
    category: "Onchain Compliance",
    Icon: ShieldCheckIcon,
    partners: [
      { name: "Range", h: 18, src: "/docs/images/partners/range.svg" },
      { name: "TRM", h: 19, src: "/docs/images/partners/trm.svg" },
      { name: "Chainalysis", h: 22, src: "/docs/images/partners/chainalysis.svg" },
      { name: "Elliptic", h: 15, src: "/docs/images/partners/elliptic.svg" },
    ],
  },
  {
    category: "RPC Node Providers",
    Icon: ServerIcon,
    partners: [
      { name: "Helius", h: 19, src: "/docs/images/partners/helius.svg" },
      { name: "Triton", h: 21, src: "/docs/images/partners/triton.svg" },
      { name: "Alchemy", h: 22, src: "/docs/images/partners/alchemy.svg" },
      { name: "QuickNode", h: 22, src: "/docs/images/partners/quicknode.svg" },
    ],
  },
];

type HomeCard = {
  name: string;
  desc: string;
  badge?: string;
} & ({ Icon: LucideIcon } | { graphic: ReactNode }) &
  ({ href: string } | { disabled: true });

const modelSteps: HomeCard[] = [
  {
    name: "Understanding SDP",
    desc: "Interfaces, authentication, and core conventions.",
    href: "/docs/introduction",
    graphic: <ArchitectureSketch />,
  },
  {
    name: "Wallets & Policies",
    desc: "Provision custody wallets and control signing with policies.",
    href: "/docs/guides/setup-wallets",
    graphic: <WalletsSketch />,
  },
  {
    name: "Issuance & Operations",
    desc: "Create and deploy Token-2022 assets with compliance controls.",
    href: "/docs/tokens/create-a-token",
    graphic: <IssuanceSketch />,
  },
  {
    name: "Ramps",
    desc: "Move between fiat and crypto through our onramp and offramp partners.",
    href: "/docs/payments/ramps",
    graphic: <RampsSketch />,
  },
  {
    name: "Onchain Transfers",
    desc: "Send batch transfers, recurring payments, or public payment requests onchain.",
    href: "/docs/payments/send-basic-payment",
    graphic: <TransfersSketch />,
  },
  {
    name: "Markets",
    desc: "Enable secondary market activity for your issued assets.",
    graphic: <MarketsSketch />,
    badge: "Coming soon",
    disabled: true,
  },
];

const tutorials: HomeCard[] = [
  {
    name: "Issue a Regulated Stablecoin",
    desc: "Build a GENIUS-compliant digital dollar on Solana with institutional custody and integrated compliance.",
    href: "/docs/tutorials/issue-a-regulated-stablecoin",
    Icon: CircleDollarSignIcon,
  },
  {
    name: "Manage Payroll with Recurring Payments",
    desc: "Schedule recurring onchain transfers to pay your team on time, every time.",
    href: "/docs/payments/send-payouts",
    Icon: RepeatIcon,
  },
  {
    name: "Cash In, Cash Out",
    desc: "Move between fiat and crypto through our onramp and offramp partners.",
    href: "/docs/payments/ramps",
    Icon: ArrowLeftRightIcon,
  },
  {
    name: "Batch Payments",
    desc: "Disburse to many recipients in a single batch transfer.",
    href: "/docs/payments/send-payouts",
    Icon: LayersIcon,
  },
  {
    name: "Payment Requests",
    desc: "Request and track inbound payments to your custody wallets.",
    href: "/docs/payments/accept-overview",
    Icon: ReceiptTextIcon,
  },
  {
    name: "Self-Hosting",
    desc: "Deploy and operate SDP on your own infrastructure. Customize it to your use case.",
    href: "/docs/self-hosting",
    Icon: ServerIcon,
  },
];

const aiResources: HomeCard[] = [
  {
    name: "Documentation for AI",
    desc: "Machine-readable entry points and ingestion guidance for agents consuming SDP.",
    href: "/docs/reference/docs-for-ai",
    Icon: BotIcon,
  },
  {
    name: "llms.txt",
    desc: "Concise discovery file with canonical URLs, supported surfaces, and key starting pages.",
    href: "/docs/ai/llms.txt",
    Icon: FileTextIcon,
  },
  {
    name: "OpenAPI Contract",
    desc: "Machine-readable API contract for the public SDP API.",
    href: "https://api.solana.com/openapi.json",
    Icon: BracesIcon,
  },
];

export function DocsHome() {
  return (
    <div className="launch-home">
      <HomePageClass />
      <div className="launch-home-actions">
        <Link href="/docs/guides/setup-organization" className="launch-home-cta-primary">
          Dashboard setup <ArrowRightIcon size={14} aria-hidden="true" />
        </Link>
        <Link href="/docs/introduction" className="launch-home-cta-secondary">
          Learn more <ArrowRightIcon size={14} aria-hidden="true" />
        </Link>
      </div>
      {/* ── Platform model ── */}
      <section className="launch-home-section">
        <SectionHeading {...HOME_SECTIONS.gettingStarted} />
        <div className="launch-home-outcomes launch-home-model-cards">
          {modelSteps.map((step) => (
            <HomeCardLink key={step.name} card={step} />
          ))}
        </div>
      </section>

      {/* ── Tutorials ── */}
      <section className="launch-home-section">
        <SectionHeading {...HOME_SECTIONS.tutorials} />
        <div className="launch-home-outcomes launch-home-model-cards">
          {tutorials.map((tutorial) => (
            <HomeCardLink key={tutorial.name} card={tutorial} />
          ))}
        </div>
      </section>

      {/* ── Build with AI ── */}
      <section className="launch-home-section">
        <SectionHeading {...HOME_SECTIONS.buildWithAi} />
        <div className="launch-home-outcomes launch-home-model-cards">
          {aiResources.map((resource) => (
            <HomeCardLink key={resource.name} card={resource} />
          ))}
        </div>
      </section>

      {/* ── Supported partners ── */}
      <section className="launch-home-section">
        <SectionHeading {...HOME_SECTIONS.partners} />
        <p className="launch-home-section-intro">
          Access the best of the Solana ecosystem with a unified experience. We provide a stable and
          consistent API and dashboard to utilize these providers according to your requirements.
        </p>
        <div className="launch-home-partners">
          {PARTNER_ROWS.map((row) => (
            <div key={row.category} className="launch-home-partners-row">
              <div className="launch-home-partners-category">
                <row.Icon size={17} aria-hidden="true" />
                {row.category}
              </div>
              <div className="launch-home-partners-logos">
                {row.partners.map((p) => (
                  <img
                    key={p.name}
                    src={p.src}
                    alt={p.name}
                    style={{ height: p.h }}
                    loading="lazy"
                    className="launch-home-partners-wordmark"
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/**
 * Compact provider-onboarding card shown under the "On this page" TOC on the
 * docs home page.
 */
export function ProviderCallout() {
  return (
    <div className="launch-docs-toc-card">
      <p className="launch-docs-toc-card-title">
        <HandshakeIcon size={16} aria-hidden="true" />
        Interested in being a provider?
      </p>
      <p className="launch-docs-toc-card-desc">
        We onboard custody, RPC, compliance, and ramp integrations through a self-service
        contribution process.
      </p>
      <Link href="/docs/reference/provider-onboarding" className="launch-docs-toc-card-link">
        Visit our guide <ArrowRightIcon size={12} aria-hidden="true" />
      </Link>
    </div>
  );
}
