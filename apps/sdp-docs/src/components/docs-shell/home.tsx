import {
  ArrowRight,
  Building2,
  CircleDollarSign,
  Coins,
  FolderOpen,
  KeyRound,
  Lock,
  Shield,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { HomePageClass } from "./home-page-class";

export const HOME_TOC = [
  { title: "Platform model", url: "#platform-model", depth: 2 },
  { title: "Outcomes", url: "#outcomes", depth: 2 },
  { title: "Quickstart", url: "#quickstart", depth: 2 },
  { title: "Key concepts", url: "#key-concepts", depth: 2 },
];

const CUSTODY_PROVIDERS = ["Privy", "Fireblocks", "Coinbase CDP", "Turnkey"];

const modelSteps = [
  {
    name: "Organization",
    desc: "Top-level entity — owns projects, wallets, and members.",
    href: "/docs/guides/setup-organization",
    Icon: Building2,
  },
  {
    name: "Projects",
    desc: "Scoped environments within an org with their own API keys and members.",
    href: "/docs/guides/setup-organization",
    Icon: FolderOpen,
  },
  {
    name: "Wallets & keys",
    desc: "Provision custody wallets and generate project-scoped API keys.",
    href: "/docs/guides/setup-wallets",
    Icon: KeyRound,
  },
  {
    name: "Tokens",
    desc: "Create, deploy, and configure Token-2022 assets.",
    href: "/docs/tokens/create-a-token",
    Icon: Coins,
  },
  {
    name: "Operations",
    desc: "Mint, burn, and transfer tokens via dashboard or API.",
    href: "/docs/tokens/mint-and-burn",
    Icon: Zap,
  },
  {
    name: "Compliance",
    desc: "Freeze, allowlist, and screen for regulated issuance.",
    href: "/docs/tokens/freeze-and-compliance",
    Icon: Shield,
  },
];

const outcomes = [
  {
    title: "Issuance — bring RWAs onchain",
    desc: "Deploy tokenized securities, stablecoins, or funds using pre-built templates with compliance controls baked in.",
    href: "/docs/tokens/create-a-token",
    Icon: CircleDollarSign,
  },
  {
    title: "Payments — move assets between wallets",
    desc: "Orchestrate transfers, manage wallet custody, and integrate payment rails into your existing systems.",
    href: "/docs/payments/send-basic-payment",
    Icon: Building2,
  },
  {
    title: "Markets — connect to liquidity",
    desc: "Enable secondary market activity for your issued assets through SDP's markets infrastructure.",
    // TODO: replace with a dedicated markets page when available
    href: "/docs/introduction",
    Icon: Lock,
  },
];

const quickstart = [
  {
    title: "Set up your account",
    desc: "Create your org, provision a custody wallet, and generate scoped API keys.",
    href: "/docs/guides/setup-organization",
  },
  {
    title: "Issue your first token",
    desc: "Pick a template (stablecoin, tokenized security, or custom), configure, and deploy.",
    href: "/docs/tokens/create-a-token",
  },
  {
    title: "Operate",
    desc: "Mint, transfer, freeze accounts, and screen addresses through the dashboard or API.",
    href: "/docs/tokens/mint-and-burn",
  },
];

export function DocsHome() {
  return (
    <div className="launch-home">
      <HomePageClass />
      <div className="launch-home-hero-divider" aria-hidden="true" />

      {/* ── Hero ── */}
      <section className="launch-home-hero">
        <h1 className="launch-home-hero-headline">
          Real-world asset issuance, payments, and markets on Solana
        </h1>
        <p className="launch-home-hero-sub">
          A dashboard and REST API for real-world asset issuance, payments, and markets on Solana —
          with built-in compliance controls.
        </p>
        <div className="launch-home-actions">
          <Link href="/docs/guides/setup-organization" className="launch-home-cta-primary">
            Dashboard setup <ArrowRight size={14} aria-hidden="true" />
          </Link>
          <Link href="/docs/reference/api" className="launch-home-cta-secondary">
            API quickstart <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </section>

      {/* ── Platform model ── */}
      <section id="platform-model" className="launch-home-section">
        <h2 className="launch-home-section-label">Platform model</h2>
        <div className="launch-home-outcomes launch-home-model-cards">
          {modelSteps.map((step) => (
            <Link
              key={step.name}
              href={step.href}
              className="launch-home-outcome launch-home-outcome--h"
            >
              <div className="launch-home-outcome-icon-wrap">
                <step.Icon size={16} aria-hidden="true" />
              </div>
              <div className="launch-home-outcome-body">
                <h3 className="launch-home-outcome-title">{step.name}</h3>
                <p className="launch-home-outcome-desc">{step.desc}</p>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* ── Trust + availability strip ── */}
      <div className="launch-home-strip">
        <div className="launch-home-strip-row">
          <span className="launch-home-strip-label">Custody</span>
          <div className="launch-home-strip-pills">
            {CUSTODY_PROVIDERS.map((p) => (
              <span key={p} className="launch-home-strip-pill">
                {p}
              </span>
            ))}
          </div>
        </div>
        <div className="launch-home-strip-divider" aria-hidden="true" />
        <div className="launch-home-strip-row">
          <span className="launch-home-strip-label">Status</span>
          <div className="launch-home-strip-pills">
            <span className="launch-home-strip-pill">Sandbox live</span>
            <span className="launch-home-strip-pill">Production by request</span>
            <span className="launch-home-strip-pill">First token in &lt;1 day</span>
          </div>
        </div>
      </div>

      {/* ── Outcomes ── */}
      <section id="outcomes" className="launch-home-section">
        <h2 className="launch-home-section-label">Outcomes</h2>
        <div className="launch-home-outcomes">
          {outcomes.map((o) => (
            <Link key={o.href} href={o.href} className="launch-home-outcome">
              <div className="launch-home-outcome-icon-wrap">
                <o.Icon size={16} aria-hidden="true" />
              </div>
              <h3 className="launch-home-outcome-title">{o.title}</h3>
              <p className="launch-home-outcome-desc">{o.desc}</p>
            </Link>
          ))}
        </div>
        <Link href="/docs/introduction" className="launch-home-more launch-home-more--below">
          See all capabilities <ArrowRight size={12} aria-hidden="true" />
        </Link>
      </section>

      {/* ── Quickstart ── */}
      <section id="quickstart" className="launch-home-section">
        <h2 className="launch-home-section-label">Quickstart</h2>
        <ol className="launch-home-quick">
          {quickstart.map((step, i) => (
            <li key={step.href} className="launch-home-quick-step">
              <Link href={step.href} className="launch-home-quick-link">
                <span className="launch-home-quick-num" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="launch-home-quick-content">
                  <h3 className="launch-home-quick-title">{step.title}</h3>
                  <p className="launch-home-quick-desc">{step.desc}</p>
                </div>
                <ArrowRight className="launch-home-quick-arrow" size={15} aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ol>
      </section>

      {/* ── Key concepts ── */}
      <section id="key-concepts" className="launch-home-section">
        <h2 className="launch-home-section-label">Key concepts</h2>
        <dl className="launch-home-concepts">
          <div className="launch-home-concept">
            <dt className="launch-home-concept-term">Environment</dt>
            <dd className="launch-home-concept-def">
              <code>sandbox</code> runs on devnet — <code>production</code> runs on mainnet-beta
            </dd>
          </div>
          <div className="launch-home-concept">
            <dt className="launch-home-concept-term">API key prefix</dt>
            <dd className="launch-home-concept-def">
              <code>sk_test_</code> for sandbox · <code>sk_live_</code> for production
            </dd>
          </div>
          <div className="launch-home-concept">
            <dt className="launch-home-concept-term">Idempotency</dt>
            <dd className="launch-home-concept-def">
              Include an <code>Idempotency-Key</code> header on mutation requests to prevent
              duplicates
            </dd>
          </div>
          <div className="launch-home-concept">
            <dt className="launch-home-concept-term">Signing modes</dt>
            <dd className="launch-home-concept-def">
              Execute (SDP signs &amp; submits) or Prepare (SDP builds, you sign) —{" "}
              <Link href="/docs/tokens/prepare-vs-execute" className="launch-home-concept-link">
                Prepare vs Execute
              </Link>
            </dd>
          </div>
        </dl>
      </section>

      {/* ── Footer hint ── */}
      <p className="launch-home-footer-note">
        Full API reference, endpoint pages, and provider onboarding live in the docs sidebar.
      </p>
    </div>
  );
}
