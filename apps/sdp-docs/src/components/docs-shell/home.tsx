import { ArrowRight } from "lucide-react";
import Link from "next/link";

const quickLinks = [
  {
    heading: "Platform Setup",
    links: [
      { label: "Setup your organization", href: "/docs/guides/setup-organization" },
      { label: "Configure wallets", href: "/docs/guides/setup-wallets" },
      { label: "Manage API keys", href: "/docs/guides/manage-api-keys" },
    ],
  },
  {
    heading: "Tokens",
    links: [
      { label: "Tokenize an asset", href: "/docs/guides/tokenize-an-asset" },
      { label: "Create a token", href: "/docs/guides/create-a-token" },
      { label: "Transfer tokens", href: "/docs/guides/transfer-tokens" },
    ],
  },
  {
    heading: "Reference",
    links: [
      { label: "API reference", href: "/docs/reference/api/index" },
      { label: "Provider onboarding", href: "/docs/reference/provider-onboarding" },
      { label: "Postman collection", href: "/docs/reference/postman-collection" },
    ],
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
        label: "Setup Organization",
        description: "Create and configure your organization",
        href: "/docs/guides/setup-organization",
      },
      {
        label: "Setup Wallets",
        description: "Provision and manage signing wallets",
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
        description: "Map real-world assets to on-chain tokens",
        href: "/docs/guides/tokenize-an-asset",
      },
      {
        label: "Create a Token",
        description: "Configure parameters and Token-2022 extensions",
        href: "/docs/guides/create-a-token",
      },
      {
        label: "Deploy a Token",
        description: "Deploy to Solana mainnet or devnet",
        href: "/docs/guides/deploy-a-token",
      },
      {
        label: "Mint and Burn",
        description: "Manage token supply on demand",
        href: "/docs/guides/mint-and-burn",
      },
      {
        label: "Manage Allowlists",
        description: "Restrict who can hold or receive tokens",
        href: "/docs/guides/manage-allowlists",
      },
      {
        label: "Freeze and Compliance",
        description: "Pause or seize token accounts",
        href: "/docs/guides/freeze-and-compliance",
      },
      {
        label: "Transfer Tokens",
        description: "Move tokens between wallets",
        href: "/docs/guides/transfer-tokens",
      },
    ],
  },
  {
    category: "Tutorials",
    items: [
      {
        label: "End-to-End Payment Flow",
        description: "Full walkthrough from setup to payment settlement",
        href: "/docs/tutorials/end-to-end-payment-flow",
      },
    ],
  },
  {
    category: "Integrations",
    items: [
      {
        label: "Provider Onboarding",
        description: "Connect custody and identity providers",
        href: "/docs/reference/provider-onboarding",
      },
      {
        label: "AI Consumption",
        description: "LLM-ready docs and machine-readable resources",
        href: "/docs/reference/ai-consumption",
      },
      {
        label: "Postman Collection",
        description: "Ready-to-import API collection",
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
        description: "Wallet provisioning endpoints",
        href: "/docs/reference/api/wallets",
      },
      {
        label: "Projects",
        description: "Project and member management",
        href: "/docs/reference/api/projects",
      },
      {
        label: "Issuance",
        description: "Token lifecycle endpoints",
        href: "/docs/reference/api/issuance",
      },
      {
        label: "Payments",
        description: "Payment transfer endpoints",
        href: "/docs/reference/api/payments",
      },
      {
        label: "Compliance",
        description: "Freeze, seize, and allowlist endpoints",
        href: "/docs/reference/api/compliance",
      },
    ],
  },
];

export function DocsHome() {
  return (
    <div className="launch-home">
      <div className="launch-home-actions">
        <Link href="/docs/getting-started" className="launch-home-cta-primary">
          Get started
          <ArrowRight aria-hidden="true" />
        </Link>
        <Link href="/docs/reference/api/index" className="launch-home-cta-secondary">
          API reference
        </Link>
      </div>

      <div className="launch-home-quicklinks">
        {quickLinks.map((section) => (
          <div key={section.heading} className="launch-home-ql-section">
            <h3 className="launch-home-ql-heading">{section.heading}</h3>
            <ul className="launch-home-ql-list">
              {section.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="launch-home-ql-link">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="launch-home-browse">
        <h2 className="launch-home-browse-heading">Browse by section</h2>
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
      </div>
    </div>
  );
}
