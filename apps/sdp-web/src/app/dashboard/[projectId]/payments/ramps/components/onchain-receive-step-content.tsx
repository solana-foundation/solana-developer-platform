"use client";

import { Combobox } from "@sdp/ui/combobox";
import { WalletIcon } from "lucide-react";
import { useMemo } from "react";
import type { OnchainReceiveWizard } from "@/app/dashboard/[projectId]/payments/ramps/hooks/use-onchain-receive-wizard";
import { walletComboboxOptions } from "@/app/dashboard/[projectId]/payments/ramps/wallet-options";
import { useTranslations } from "@/i18n/provider";
import { WalletReceiveCard } from "./wallet-receive-card";

export function OnchainReceiveStepContent({ wizard }: { wizard: OnchainReceiveWizard }) {
  const t = useTranslations();
  const { currentStepId, liveWallets, walletsLoading, selectedWallet, walletId, setWalletId } =
    wizard;

  const walletOptions = useMemo(() => walletComboboxOptions(liveWallets), [liveWallets]);

  if (currentStepId === "WALLET") {
    return (
      <Combobox
        label={t("DashboardPayments.ramps.destinationWallet")}
        value={walletId === "" ? null : walletId}
        onChange={setWalletId}
        options={walletOptions}
        placeholder={t("DashboardPayments.ramps.selectDestinationWallet")}
        searchPlaceholder={t("DashboardPayments.ramps.searchWallets")}
        icon={<WalletIcon className="size-5 shrink-0 text-tertiary" />}
        isLoading={walletsLoading}
      />
    );
  }

  if (selectedWallet === null) {
    return null;
  }
  return <WalletReceiveCard address={selectedWallet.publicKey} />;
}
