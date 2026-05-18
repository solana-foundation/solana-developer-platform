import { ArrowRight, ChevronRight } from "lucide-react";
import Link from "next/link";

export const HOME_TOC = [
  { title: "What you can do", url: "#what-you-can-do", depth: 2 },
  { title: "How SDP fits together", url: "#platform-model", depth: 2 },
  { title: "Choose your path", url: "#choose-your-path", depth: 2 },
  { title: "Start here", url: "#start-here", depth: 2 },
  { title: "Developer resources", url: "#developer-resources", depth: 2 },
  { title: "Browse all docs", url: "#browse-all", depth: 2 },
];

const capabilities = [
  {
    title: "Issue tokens",
    desc: "Create and deploy Token-2022 tokens using stablecoin, tokenized-security, or custom templates.",
    href: "/docs/tokens/create-a-token",
  },
  {
    title: "Manage custody",
    desc: "Connect Privy, Fireblocks, Coinbase CDP, Turnkey, and other custody providers to sign transactions.",
    href: "/docs/guides/setup-wallets",
  },
  {
    title: "Mint and burn",
    desc: "Increase or decrease token supply on demand with minting and burning operations.",
    href: "/docs/tokens/mint-and-burn",
  },
  {
    title: "Transfer tokens",
    desc: "Move tokens between accounts using the Payments API with idempotent execution.",
    href: "/docs/tokens/transfer-tokens",
  },
  {
    title: "Compliance controls",
    desc: "Freeze accounts, pause transfers, screen addresses, and manage allowlists for regulated tokens.",
    href: "/docs/tokens/freeze-and-compliance",
  },
  {
    title: "Flexible signing",
    desc: "Choose Execute mode (SDP signs) or Prepare mode (you sign) for any onchain operation.",
    href: "/docs/tokens/prepare-vs-execute",
  },
];

const modelSteps = [
  {
    name: "Organization",
    desc: "Top-level container for all resources",
    href: "/docs/guides/setup-organization",
  },
  {
    name: "Wallets & Keys",
    desc: "Custody providers and scoped API access",
    href: "/docs/guides/setup-wallets",
  },
  {
    name: "Tokens",
    desc: "Create, deploy, and configure",
    href: "/docs/tokens/create-a-token",
  },
  {
    name: "Operations",
    desc: "Mint, burn, and transfer",
    href: "/docs/tokens/mint-and-burn",
  },
  {
    name: "Compliance",
    desc: "Freeze, allowlists, screening",
    href: "/docs/tokens/freeze-and-compliance",
  },
];

const paths = [
  {
    title: "Dashboard",
    desc: "Step-by-step guides for teams setting up and operating SDP through the UI.",
    cta: "Get started",
    href: "/docs/getting-started",
  },
  {
    title: "REST API",
    desc: "Endpoint reference, OpenAPI spec, and Postman collection for developers integrating directly.",
    cta: "API reference",
    href: "/docs/reference/api/index",
  },
];

const onboardingSteps = [
  {
    title: "What is Solana Developer Platform?",
    desc: "Understand the architecture, environments, and signing modes.",
    href: "/docs/what-is-solana-developer-platform",
  },
  {
    title: "Set Up Your Organization",
    desc: "Create the top-level container for all your SDP resources.",
    href: "/docs/guides/setup-organization",
  },
  {
    title: "Set Up Wallets",
    desc: "Initialize a custody provider and create signing wallets.",
    href: "/docs/guides/setup-wallets",
  },
  {
    title: "Manage API Keys",
    desc: "Generate scoped keys for sandbox and production environments.",
    href: "/docs/guides/manage-api-keys",
  },
  {
    title: "Create a Token",
    desc: "Define a token using a template, then deploy it to Solana.",
    href: "/docs/tokens/create-a-token",
  },
];

const devResources = [
  {
    title: "API Reference",
    desc: "Full endpoint index generated from the OpenAPI contract.",
    href: "/docs/reference/api/index",
  },
  {
    title: "Postman Collection",
    desc: "Ready-to-import collection covering all public API families.",
    href: "/docs/reference/postman-collection",
  },
  {
    title: "Provider Onboarding",
    desc: "Self-service process for adding custody, RPC, compliance, or ramp integrations.",
    href: "/docs/reference/provider-onboarding",
  },
  {
    title: "AI Consumption",
    desc: "Machine-readable resources and ingestion guidance for agents and LLMs.",
    href: "/docs/reference/ai-consumption",
  },
];

const browseCategories = [
  {
    category: "Getting Started",
    items: [
      {
        label: "What is Solana Developer Platform?",
        description: "Overview of SDP, architecture, and environments",
        href: "/docs/what-is-solana-developer-platform",
      },
      {
        label: "Getting Started",
        description: "Create an org, provision a wallet, issue your first token",
        href: "/docs/getting-started",
      },
    ],
  },
  {
    category: "Platform Setup",
    items: [
      {
        label: "Set Up Your Organization",
        description: "Create and configure your organization",
        href: "/docs/guides/setup-organization",
      },
      {
        label: "Set Up Wallets",
        description: "Initialize custody providers and manage signing wallets",
        href: "/docs/guides/setup-wallets",
      },
      {
        label: "Manage API Keys",
        description: "Generate scoped keys and rotate without downtime",
        href: "/docs/guides/manage-api-keys",
      },
    ],
  },
  {
    category: "Tokens",
    items: [
      {
        label: "Tokenize an Asset",
        description: "Map a real-world asset to the right token model and flow",
        href: "/docs/tokens/tokenize-an-asset",
      },
      {
        label: "Create a Token",
        description: "Configure parameters and Token-2022 extensions",
        href: "/docs/tokens/create-a-token",
      },
      {
        label: "Deploy a Token",
        description: "Deploy to Solana mainnet or devnet",
        href: "/docs/tokens/deploy-a-token",
      },
      {
        label: "Mint and Burn",
        description: "Increase or decrease token supply on demand",
        href: "/docs/tokens/mint-and-burn",
      },
      {
        label: "Transfer Tokens",
        description: "Move tokens between accounts via the Payments API",
        href: "/docs/tokens/transfer-tokens",
      },
      {
        label: "Allowlists",
        description: "Control which addresses can hold your token",
        href: "/docs/tokens/allowlists",
      },
      {
        label: "Freeze and Compliance",
        description: "Pause or seize token accounts for compliance workflows",
        href: "/docs/tokens/freeze-and-compliance",
      },
      {
        label: "Manage Token Settings",
        description: "Rotate or revoke authorities after deployment",
        href: "/docs/tokens/manage-token-settings",
      },
      {
        label: "Prepare vs Execute",
        description: "Choose the right signing mode for your integration",
        href: "/docs/tokens/prepare-vs-execute",
      },
    ],
  },
  {
    category: "Tutorials",
    items: [
      {
        label: "End-to-end Payment Flow",
        description: "Full walkthrough from quote to settlement",
        href: "/docs/tutorials/end-to-end-payment-flow",
      },
    ],
  },
  {
    category: "Reference",
    items: [
      {
        label: "Issuance Token Types",
        description: "Supported templates and default extension sets",
        href: "/docs/reference/issuance-token-types",
      },
      {
        label: "Provider Onboarding",
        description: "Add custody, RPC, compliance, or ramp providers",
        href: "/docs/reference/provider-onboarding",
      },
      {
        label: "AI Consumption",
        description: "Machine-readable resources for agents and LLMs",
        href: "/docs/reference/ai-consumption",
      },
      {
        label: "Postman Collection",
        description: "Generated from the OpenAPI contract",
        href: "/docs/reference/postman-collection",
      },
    ],
  },
  {
    category: "API Reference",
    items: [
      {
        label: "API Keys",
        description: "Key management endpoints",
        href: "/docs/reference/api/api-keys",
      },
      {
        label: "Wallets",
        description: "Wallet provisioning and custody configuration",
        href: "/docs/reference/api/wallets",
      },
      {
        label: "Projects",
        description: "Project and member management",
        href: "/docs/reference/api/projects",
      },
      {
        label: "Issuance",
        description: "Token lifecycle — create, deploy, mint, burn, freeze",
        href: "/docs/reference/api/issuance",
      },
      {
        label: "Payments",
        description: "Transfers, balances, ramps, and policies",
        href: "/docs/reference/api/payments",
      },
      {
        label: "Compliance",
        description: "Address risk screening",
        href: "/docs/reference/api/compliance",
      },
    ],
  },
];

export function DocsHome() {
  return (
    <div className="launch-home">

      {/* ── Hero ── */}
      <section className="launch-home-hero">
        <p className="launch-home-hero-label">Solana Developer Platform</p>
        <h1 className="launch-home-hero-headline">
          Issue, transfer, and manage Solana tokens
        </h1>
        <p className="launch-home-hero-sub">
          A dashboard and REST API for token issuance, custody, transfers, and compliance — without managing keys or onchain infrastructure.
        </p>
        <div className="launch-home-actions">
          <Link href="/docs/getting-started" className="launch-home-cta-primary">
            Get started
            <ArrowRight aria-hidden="true" />
          </Link>
          <Link href="/docs/reference/api/index" className="launch-home-cta-secondary">
            API reference
          </Link>
          <Link href="/docs/what-is-solana-developer-platform" className="launch-home-cta-ghost">
            What is SDP?
          </Link>
        </div>
      </section>

      {/* ── Capabilities ── */}
      <section id="what-you-can-do" className="launch-home-section">
        <p className="launch-home-section-label">What you can do</p>
        <div className="launch-home-caps">
          {capabilities.map((cap) => (
            <Link key={cap.href} href={cap.href} className="launch-home-cap-card">
              <span className="launch-home-cap-title">{cap.title}</span>
              <p className="launch-home-cap-desc">{cap.desc}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* ── Platform model ── */}
      <section id="platform-model" className="launch-home-section">
        <p className="launch-home-section-label">How SDP fits together</p>
        <div className="launch-home-model">
          {modelSteps.map((step, i) => (
            <div key={step.href} className="launch-home-model-item">
              <Link href={step.href} className="launch-home-model-step">
                <span className="launch-home-model-name">{step.name}</span>
                <span className="launch-home-model-desc">{step.desc}</span>
              </Link>
              {i < modelSteps.length - 1 && (
                <ChevronRight className="launch-home-model-arrow" aria-hidden="true" />
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── Choose your path ── */}
      <section id="choose-your-path" className="launch-home-section">
        <p className="launch-home-section-label">Choose your path</p>
        <div className="launch-home-paths">
          {paths.map((path) => (
            <Link key={path.href} href={path.href} className="launch-home-path-card">
              <span className="launch-home-path-title">{path.title}</span>
              <p className="launch-home-path-desc">{path.desc}</p>
              <span className="launch-home-path-cta">
                {path.cta} <ArrowRight size={12} aria-hidden="true" />
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* ── Start here ── */}
      <section id="start-here" className="launch-home-section">
        <p className="launch-home-section-label">Start here</p>
        <ol className="launch-home-onboarding">
          {onboardingSteps.map((step, i) => (
            <li key={step.href} className="launch-home-onboarding-step">
              <span className="launch-home-onboarding-num" aria-hidden="true">{i + 1}</span>
              <div className="launch-home-onboarding-content">
                <Link href={step.href} className="launch-home-onboarding-link">
                  {step.title}
                </Link>
                <p className="launch-home-onboarding-desc">{step.desc}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* ── Developer resources ── */}
      <section id="developer-resources" className="launch-home-section">
        <p className="launch-home-section-label">Developer resources</p>
        <div className="launch-home-resources">
          {devResources.map((r) => (
            <Link key={r.href} href={r.href} className="launch-home-resource">
              <span className="launch-home-resource-title">{r.title}</span>
              <p className="launch-home-resource-desc">{r.desc}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* ── Browse all docs ── */}
      <section id="browse-all" className="launch-home-section">
        <h2 className="launch-home-browse-heading">Browse all docs</h2>
        {browseCategories.map((group) => (
          <div key={group.category} className="launch-home-browse-group">
            <div className="launch-home-browse-category">{group.category}</div>
            <div className="launch-home-browse-grid">
              {group.items.map((item) => (
                <div key={item.href} className="launch-home-browse-item">
                  <Link href={item.href} className="launch-home-browse-link">
                    {item.label}
                  </Link>
                  <p className="launch-home-browse-desc">{item.description}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>

    </div>
  );
}
