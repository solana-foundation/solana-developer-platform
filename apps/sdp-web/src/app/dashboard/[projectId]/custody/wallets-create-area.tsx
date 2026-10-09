"use client";

import { PlusIcon } from "lucide-react";
import { useMemo } from "react";
import type { KnownCustodyProvider } from "@/app/dashboard/[projectId]/custody/provider-catalog";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import type { ProjectCustodyAvailability } from "@/lib/provider-availability";
import {
  type CustodyProviderAvailability,
  resolveCustodyProviderAvailability,
} from "./provider-display-status";

/** The project's custody availability, or `ok: false` when it could not be read. */
export type CustodyAvailabilityResult =
  | { ok: true; providers: ProjectCustodyAvailability[] }
  | { ok: false };

interface WalletCreateArea {
  providerAvailability: CustodyProviderAvailability[] | null;
  createOptionsUnavailable: boolean;
  canCreateWallet: boolean;
}

/**
 * Resolves the providers the wallet create area offers and whether it is open or failed closed.
 * Availability that could not be read resolves to `null`, which closes creation instead of
 * offering an unverified provider list.
 *
 * @param params - The viewer's permission and the project's custody state.
 * @param params.canManageCustody - Whether the viewer may create wallets.
 * @param params.connectedProviders - Providers with a custody connection on the project.
 * @param params.custodyAvailability - The project's custody availability read.
 * @returns The resolved provider availability, whether to show the unavailable notice, and
 *   whether wallet creation is open.
 */
export function useWalletCreateArea({
  canManageCustody,
  connectedProviders,
  custodyAvailability,
}: {
  canManageCustody: boolean;
  connectedProviders: KnownCustodyProvider[];
  custodyAvailability: CustodyAvailabilityResult;
}): WalletCreateArea {
  const providerAvailability = useMemo(
    () =>
      custodyAvailability.ok
        ? resolveCustodyProviderAvailability({
            connectedProviders,
            custodyAvailability: custodyAvailability.providers,
          })
        : null,
    [connectedProviders, custodyAvailability]
  );
  return {
    providerAvailability,
    createOptionsUnavailable: canManageCustody && providerAvailability === null,
    canCreateWallet:
      canManageCustody && providerAvailability !== null && providerAvailability.length > 0,
  };
}

/** Inline notice that the create area is closed because availability could not be read. */
export function CreateOptionsUnavailable() {
  const t = useTranslations();
  return (
    <p
      role="alert"
      className="rounded-2xl border border-destructive/15 bg-destructive/[0.04] px-5 py-4 text-sm leading-6 text-destructive-strongest"
    >
      {t("DashboardCustody.walletCreationOptionsUnavailable")}
    </p>
  );
}

/**
 * Toolbar button that opens wallet creation without a preselected provider.
 *
 * @param props.onClick - Opens the create-wallet flow.
 * @returns The create-wallet button.
 */
export function CreateWalletButton({ onClick }: { onClick: () => void }) {
  const t = useTranslations();
  return (
    <Button
      type="button"
      className="w-full sm:w-auto"
      onClick={onClick}
      iconLeft={<PlusIcon className="h-4 w-4" />}
    >
      {t("DashboardCustody.createWallet")}
    </Button>
  );
}

/**
 * Dashed grid tile that opens wallet creation without a preselected provider.
 *
 * @param props.onClick - Opens the create-wallet flow.
 * @returns The create-wallet tile.
 */
export function CreateWalletTile({ onClick }: { onClick: () => void }) {
  const t = useTranslations();
  return (
    <button
      type="button"
      onClick={onClick}
      data-wallet-create-tile
      className="flex cursor-pointer items-center justify-center rounded-2xl border border-dashed border-border-strong bg-surface-raised text-tertiary transition-colors hover:border-primary/40 hover:text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-default focus-visible:ring-offset-2"
      aria-label={t("DashboardCustody.createWallet")}
    >
      <PlusIcon className="h-6 w-6" />
    </button>
  );
}
