import { CUSTODY_PROVIDER_CATEGORY_DETAILS } from "@sdp/types/custody";
import {
  type ComplianceIntegration,
  type IntegrationFamily,
  type IntegrationState,
  isConfigurableIntegrationStatus,
  type ProjectIntegrationFamily,
  type ProjectIntegrations,
  type RampIntegration,
  type RpcIntegration,
} from "@sdp/types/integrations";
import { VenetianMaskIcon } from "lucide-react";
import type { ReactNode } from "react";
import { PRIVATE_CHANNELS_OVERVIEW_PATH } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-routes";
import { getCustodyProviderEntry } from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import { ProviderBrandMark } from "@/components/provider-brand-mark";
import type { DashboardFlags } from "@/flags/dashboard";
import type { MessageKey } from "@/i18n/messages";
import type { useTranslations } from "@/i18n/provider";
import {
  COMPLIANCE_BRAND_MARKS,
  CUSTODY_BRAND_MARKS,
  RAMP_BRAND_MARKS,
  RPC_BRAND_MARKS,
} from "@/lib/provider-brand-marks";

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

// Mark, name, category, state, chevron: one grid so every row's columns line up.
export const INTEGRATION_ROW_COLUMNS =
  "grid grid-cols-[2.75rem_minmax(0,1fr)_auto_1rem] items-center gap-x-3 md:grid-cols-[2.75rem_minmax(0,1fr)_11rem_10rem_1rem]";

const RAMP_PROVIDER_LABELS = {
  moonpay: "MoonPay",
  stripe: "Stripe",
  hercle: "Hercle",
} as const satisfies Record<RampIntegration["provider"], string>;

const RAMP_DESCRIPTION_KEYS = {
  moonpay: "Shared.integrations.rampMoonpayDescription",
  stripe: "Shared.integrations.rampStripeDescription",
  hercle: "Shared.integrations.rampHercleDescription",
} as const satisfies Record<RampIntegration["provider"], MessageKey>;

const COMPLIANCE_PROVIDER_LABELS = {
  range: "Range",
  elliptic: "Elliptic",
  trm: "TRM Labs",
  chainalysis: "Chainalysis",
} as const satisfies Record<ComplianceIntegration["provider"], string>;

const COMPLIANCE_DESCRIPTION_KEYS = {
  range: "Shared.integrations.complianceRangeDescription",
  elliptic: "Shared.integrations.complianceEllipticDescription",
  trm: "Shared.integrations.complianceTrmDescription",
  chainalysis: "Shared.integrations.complianceChainalysisDescription",
} as const satisfies Record<ComplianceIntegration["provider"], MessageKey>;

function hrefWhenConfigurable(state: IntegrationState, href: string): string | null {
  return isConfigurableIntegrationStatus(state.status) ? href : null;
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
          icon: <ProviderBrandMark size="list" mark={CUSTODY_BRAND_MARKS[integration.provider]} />,
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
        icon: <ProviderBrandMark size="list" mark={RPC_BRAND_MARKS[integration.provider]} />,
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
        icon: <ProviderBrandMark size="list" mark={RAMP_BRAND_MARKS[integration.provider]} />,
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
        icon: <ProviderBrandMark size="list" mark={COMPLIANCE_BRAND_MARKS[integration.provider]} />,
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
