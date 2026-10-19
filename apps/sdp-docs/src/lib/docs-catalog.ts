/**
 * Docs-owned descriptions of SDP's modules, ramp providers and the action
 * modules an API key can be granted. Pages never list these by hand: the generated blocks in
 * docs-blocks.ts render them for whatever the build's release channel publishes
 * (src/generated/public-surface.json), so a module or provider appears in an
 * overview exactly when its own pages do.
 *
 * Free of runtime workspace imports (types only), like release-channel.ts:
 * source.config.ts loads it.
 */

import type { ActionModule } from "@sdp/types/actions";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { SdpModule } from "@sdp/types/release-channels";

/** One product module as the introduction and the AI guide describe it. */
export type ModuleEntry = {
  /** An SDP module, or `core` for what every channel runs. */
  module: SdpModule | "core";
  name: string;
  summary: string;
  /** The capability line the llms files and the AI guide list. */
  capability: string;
};

export const DOCS_MODULES: readonly ModuleEntry[] = [
  {
    module: "issuance",
    name: "Issuance",
    summary: "Deploy, mint, burn, freeze, pause, and seize tokens built on Token-2022",
    capability: "Token issuance and lifecycle operations",
  },
  {
    module: "custody",
    name: "Custody",
    summary: "Provision and operate Solana wallets through interchangeable custody providers",
    capability: "Wallets and custody",
  },
  {
    module: "core",
    name: "API keys and projects",
    summary: "Project-scoped API keys with explicit grants by module",
    capability: "API key management and projects",
  },
  {
    module: "payments",
    name: "Payments",
    summary: "Move funds onchain — transfers, batches, recurring payments, and payment requests",
    capability: "Payments, transfers, and recurring payments",
  },
  {
    module: "ramps",
    name: "Ramps",
    summary: "Move between fiat and onchain funds through interchangeable ramp providers",
    capability: "Fiat on-ramps and off-ramps",
  },
  {
    module: "compliance",
    name: "Compliance",
    summary: "Screen wallets and transactions against your regulatory program",
    capability: "Compliance screening",
  },
  {
    module: "issuance",
    name: "Asset profiles",
    summary: "Issued-asset identity and metadata, and the public token metadata URI",
    capability: "Asset profiles and public token metadata",
  },
];

/** One ramp provider's capabilities; its page is /docs/payments/ramps-<provider>. */
export type RampProviderEntry = {
  provider: RampProviderId;
  name: string;
  onramp: string;
  offramp: string;
  sandbox: string;
  deliveryMode: string;
  bestFor: string;
  notes: string;
};

export const DOCS_RAMP_PROVIDERS: readonly RampProviderEntry[] = [
  {
    provider: "moonpay",
    name: "MoonPay",
    onramp: "✓",
    offramp: "✓",
    sandbox: "✓",
    deliveryMode: "hosted",
    bestFor: "Fast sandbox iteration; broad payment-method coverage (corridor-dependent).",
    notes: "Separate sandbox and production credentials, chosen per request.",
  },
  {
    provider: "stripe",
    name: "Stripe",
    onramp: "✓",
    offramp: "✗",
    sandbox: "✓ (shared credentials)",
    deliveryMode: "session_widget",
    bestFor: "Widget/session-embedded onramp UI; onramp only.",
    notes: "No separate sandbox credentials — supply a Stripe test-mode secret key.",
  },
];

/**
 * A code fence tagged `rotate-providers` names this provider; the page rotates
 * it through the published providers (source.config.ts) and text outputs name
 * the first published one (docs-blocks.ts).
 */
export const ROTATE_PROVIDERS_TOKEN = '"moonpay"';

/** The ramp providers this build publishes, in catalog order. */
export function publishedRampProviderIds(published: readonly RampProviderId[]): RampProviderId[] {
  const publishedIds = new Set(published);
  return DOCS_RAMP_PROVIDERS.map((entry) => entry.provider).filter((id) => publishedIds.has(id));
}

/** What each action module covers; which verbs it has comes from the manifest. */
export const DOCS_ACTION_MODULES = {
  transfers: "Single transfers from a custody wallet",
  transfer_batches: "Batches of transfers, and their estimates",
  payment_requests: "Payment requests and their payment links",
  counterparties: "Counterparties, their accounts, and provider requirements",
  transactions: "The unified transaction list; each row also needs the read of its own module",
  recurring: "Recurring payments, subscription plans and subscriptions",
  wallets: "Custody wallets and their balances",
  compliance: "Address screening",
  api_keys: "API keys",
  projects: "Projects and provider availability",
  members: "Organization and project members",
  organizations: "Organization settings and provider access",
  rpc: "The managed Solana RPC relay",
  onramp: "On-ramp currencies, estimates and quotes",
  offramp: "Off-ramp currencies, estimates and quotes",
  ramp_transfers: "Ramp transfer cancellation and sandbox simulation",
  issuance: "Tokens, templates, asset profiles, and their on-chain actions",
  dvp: "Delivery-versus-payment trades",
  earn: "Earn strategies, deposits, withdrawals and programs",
  private_channels: "Private channel instances, channels and movements",
  helius_rings: "Helius Rings wallets, rings and operations",
} as const satisfies Record<ActionModule, string>;
