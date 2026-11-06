import { CUSTODY_PROVIDER_CATEGORY_DETAILS } from "@sdp/types/custody";
import type {
  ComplianceIntegration,
  CustodyIntegration,
  IntegrationFamily,
  IntegrationState,
  ProjectIntegrationFamily,
  ProjectIntegrations,
  RampIntegration,
  RpcIntegration,
} from "@sdp/types/integrations";
import { cn } from "@sdp/ui/cn";
import { KeyRoundIcon, VenetianMaskIcon } from "lucide-react";
import Image from "next/image";
import type { ReactNode } from "react";
import { PRIVATE_CHANNELS_OVERVIEW_PATH } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-routes";
import { getCustodyProviderEntry } from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import type { DashboardFlags } from "@/flags/dashboard";
import type { MessageKey } from "@/i18n/messages";
import type { useTranslations } from "@/i18n/provider";
import {
  COMPLIANCE_DESCRIPTION_KEYS,
  COMPLIANCE_PROVIDER_LABELS,
  RAMP_DESCRIPTION_KEYS,
  RAMP_PROVIDER_LABELS,
} from "./integrations-status";

type Translate = ReturnType<typeof useTranslations>;

export interface IntegrationRow {
  key: string;
  provider: string;
  label: string;
  description: string;
  icon: ReactNode;
  category: string | null;
  state: IntegrationState;
  /** The provider's page; null when there is nothing for the project to configure. */
  href: string | null;
}

export interface IntegrationSection {
  family: ProjectIntegrationFamily;
  title: string;
  description: string;
  rows: IntegrationRow[];
}

export const INTEGRATION_FAMILY_COPY_KEYS = {
  custody: {
    title: "Shared.integrations.custodyTitle",
    description: "Shared.integrations.custodyDescription",
  },
  rpc: { title: "Shared.integrations.rpcTitle", description: "Shared.integrations.rpcDescription" },
  ramps: {
    title: "Shared.integrations.rampsTitle",
    description: "Shared.integrations.rampsDescription",
  },
  compliance: {
    title: "Shared.integrations.complianceTitle",
    description: "Shared.integrations.complianceDescription",
  },
  private_channels: {
    title: "Shared.integrations.privacyTitle",
    description: "Shared.integrations.privacyDescription",
  },
} as const satisfies Record<
  ProjectIntegrationFamily,
  { title: MessageKey; description: MessageKey }
>;

const RPC_PROVIDER_LABELS = {
  alchemy: "Alchemy",
  helius: "Helius",
  nodit: "Nodit",
  quicknode: "QuickNode",
  triton: "Triton",
  validationcloud: "Validation Cloud",
} as const satisfies Record<RpcIntegration["provider"], string>;

interface BrandMark {
  logo: string;
  background: string;
  /** Light backgrounds take a hairline ring so the circle still reads on the page. */
  ringed: boolean;
}

const CUSTODY_BRAND_MARKS: Partial<Record<CustodyIntegration["provider"], BrandMark>> = {
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
};

const RPC_BRAND_MARKS = {
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
} as const satisfies Record<RpcIntegration["provider"], BrandMark>;

const RAMP_BRAND_MARKS = {
  moonpay: { logo: "/provider-logos/brand/moonpay.png", background: "#000000", ringed: false },
  stripe: { logo: "/provider-logos/brand/stripe.svg", background: "#533afd", ringed: false },
} as const satisfies Record<RampIntegration["provider"], BrandMark>;

const COMPLIANCE_BRAND_MARKS = {
  chainalysis: {
    logo: "/provider-logos/brand/chainalysis.svg",
    background: "#fffdfc",
    ringed: true,
  },
  elliptic: { logo: "/provider-logos/brand/elliptic.svg", background: "#0f0f13", ringed: false },
  range: { logo: "/provider-logos/brand/range.svg", background: "#22533e", ringed: false },
  trm: { logo: "/provider-logos/brand/trm.svg", background: "#0f0f13", ringed: false },
} as const satisfies Record<ComplianceIntegration["provider"], BrandMark>;

const MARK_CLASS = "relative inline-flex size-10 shrink-0 items-center justify-center rounded-full";

function IntegrationMark({ mark }: { mark: BrandMark | undefined }) {
  if (mark === undefined) {
    return (
      <span aria-hidden className={cn(MARK_CLASS, "bg-fill-strong")}>
        <KeyRoundIcon className="size-5 text-secondary" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(MARK_CLASS, mark.ringed && "shadow-[inset_0_0_0_1px_rgba(15,15,19,0.1)]")}
      style={{ backgroundColor: mark.background }}
    >
      <Image src={mark.logo} alt="" width={24} height={24} className="size-6 object-contain" />
    </span>
  );
}

/** Whether the project has anything to set up for an integration in this state. */
export function isConfigurable(state: IntegrationState): boolean {
  return state.status !== "provided";
}

function hrefWhenConfigurable(state: IntegrationState, href: string): string | null {
  return isConfigurable(state) ? href : null;
}

function familyRows(family: IntegrationFamily, t: Translate): IntegrationRow[] {
  switch (family.family) {
    case "custody":
      return family.integrations.map((integration) => {
        const entry = getCustodyProviderEntry(integration.provider);
        return {
          key: `custody:${integration.provider}`,
          provider: integration.provider,
          label: entry.label,
          description: t(entry.descriptionKey),
          icon: <IntegrationMark mark={CUSTODY_BRAND_MARKS[integration.provider]} />,
          category: t(CUSTODY_PROVIDER_CATEGORY_DETAILS[integration.category].labelKey),
          state: integration.state,
          href: hrefWhenConfigurable(
            integration.state,
            `/dashboard/integrations/${integration.provider}`
          ),
        };
      });
    case "rpc":
      return family.integrations.map((integration) => ({
        key: `rpc:${integration.provider}`,
        provider: integration.provider,
        label: RPC_PROVIDER_LABELS[integration.provider],
        description: t("Shared.integrations.rpcProviderDescription"),
        icon: <IntegrationMark mark={RPC_BRAND_MARKS[integration.provider]} />,
        category: null,
        state: integration.state,
        href: null,
      }));
    case "ramps":
      return family.integrations.map((integration) => ({
        key: `ramps:${integration.provider}`,
        provider: integration.provider,
        label: RAMP_PROVIDER_LABELS[integration.provider],
        description: t(RAMP_DESCRIPTION_KEYS[integration.provider]),
        icon: <IntegrationMark mark={RAMP_BRAND_MARKS[integration.provider]} />,
        category: null,
        state: integration.state,
        href: null,
      }));
    case "compliance":
      return family.integrations.map((integration) => ({
        key: `compliance:${integration.provider}`,
        provider: integration.provider,
        label: COMPLIANCE_PROVIDER_LABELS[integration.provider],
        description: t(COMPLIANCE_DESCRIPTION_KEYS[integration.provider]),
        icon: <IntegrationMark mark={COMPLIANCE_BRAND_MARKS[integration.provider]} />,
        category: null,
        state: integration.state,
        href: null,
      }));
    case "private_channels":
      return family.integrations.map((integration) => ({
        key: "private_channels",
        provider: integration.provider,
        label: t("Shared.dashboardShell.privateChannels"),
        description: t("Shared.integrations.privateChannelsDescription"),
        icon: (
          <span
            aria-hidden
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-fill-strong"
          >
            <VenetianMaskIcon className="size-5 text-secondary" strokeWidth={1.8} />
          </span>
        ),
        category: null,
        state: integration.state,
        href: hrefWhenConfigurable(integration.state, PRIVATE_CHANNELS_OVERVIEW_PATH),
      }));
    default: {
      const exhaustive: never = family;
      throw new Error(`Unknown integration family: ${String(exhaustive)}`);
    }
  }
}

export function integrationSections(
  integrations: ProjectIntegrations,
  t: Translate
): IntegrationSection[] {
  return integrations.families.map((family) => ({
    family: family.family,
    title: t(INTEGRATION_FAMILY_COPY_KEYS[family.family].title),
    description: t(INTEGRATION_FAMILY_COPY_KEYS[family.family].description),
    rows: familyRows(family, t),
  }));
}

/** The families this deployment runs, in the read's order; RPC runs everywhere. */
export function integrationTabFamilies(
  flags: Pick<DashboardFlags, "custody" | "ramps" | "compliance" | "privateChannels">
): ProjectIntegrationFamily[] {
  return [
    ...(flags.custody ? (["custody"] as const) : []),
    "rpc",
    ...(flags.ramps ? (["ramps"] as const) : []),
    ...(flags.compliance ? (["compliance"] as const) : []),
    ...(flags.privateChannels ? (["private_channels"] as const) : []),
  ];
}
