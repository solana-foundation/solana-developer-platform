import { CUSTODY_PROVIDER_CATEGORY_DETAILS } from "@sdp/types/custody";
import type {
  IntegrationFamily,
  IntegrationState,
  ProjectIntegrationFamily,
  ProjectIntegrations,
  RpcIntegration,
} from "@sdp/types/integrations";
import { VenetianMaskIcon } from "lucide-react";
import Image from "next/image";
import type { ReactNode } from "react";
import { PRIVATE_CHANNELS_OVERVIEW_PATH } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-routes";
import { getCustodyProviderEntry } from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import { WalletProviderMark } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-provider-mark";
import type { MessageKey } from "@/i18n/messages";
import type { useTranslations } from "@/i18n/provider";
import { COMPLIANCE_PROVIDER_LOGOS } from "@/lib/compliance";
import { RAMP_PROVIDER_LOGOS } from "@/lib/ramps";
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

const FAMILY_COPY_KEYS = {
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

const RPC_PROVIDER_PRESENTATION = {
  alchemy: { label: "Alchemy", logo: "/provider-logos/alchemy-rpc.svg" },
  helius: { label: "Helius", logo: "/provider-logos/helius-rpc.svg" },
  nodit: { label: "Nodit", logo: "/provider-logos/nodit-rpc.svg" },
  quicknode: { label: "QuickNode", logo: "/provider-logos/quicknode-rpc.svg" },
  triton: { label: "Triton", logo: "/provider-logos/triton-rpc.svg" },
  validationcloud: { label: "Validation Cloud", logo: "/provider-logos/validation-cloud-rpc.svg" },
} as const satisfies Record<RpcIntegration["provider"], { label: string; logo: string }>;

/** Whether the project has anything to set up for an integration in this state. */
export function isConfigurable(state: IntegrationState): boolean {
  return state.status !== "provided";
}

function LogoMark({ src }: { src: string }) {
  // Logos sit on a white chip so dark-mode artwork with transparent backgrounds stays legible.
  return (
    <span
      aria-hidden
      className="relative inline-flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border-subtle bg-[white] p-3"
    >
      <span className="relative size-full">
        <Image src={src} alt="" fill sizes="40px" className="object-contain" />
      </span>
    </span>
  );
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
          icon: <WalletProviderMark provider={integration.provider} size="list" />,
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
        label: RPC_PROVIDER_PRESENTATION[integration.provider].label,
        description: t("Shared.integrations.rpcProviderDescription"),
        icon: <LogoMark src={RPC_PROVIDER_PRESENTATION[integration.provider].logo} />,
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
        icon: <LogoMark src={RAMP_PROVIDER_LOGOS[integration.provider]} />,
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
        icon: <LogoMark src={COMPLIANCE_PROVIDER_LOGOS[integration.provider]} />,
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
    title: t(FAMILY_COPY_KEYS[family.family].title),
    description: t(FAMILY_COPY_KEYS[family.family].description),
    rows: familyRows(family, t),
  }));
}
