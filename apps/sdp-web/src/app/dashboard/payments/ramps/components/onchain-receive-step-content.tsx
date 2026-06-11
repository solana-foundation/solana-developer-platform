"use client";

import { WalletIcon } from "lucide-react";
import { useMemo } from "react";
import { Combobox } from "@/components/ui/combobox";
import type { OnchainReceiveWizard } from "../hooks/use-onchain-receive-wizard";
import { walletComboboxOptions } from "../wallet-options";
import { WalletReceiveCard } from "./wallet-receive-card";

export function OnchainReceiveStepContent({ wizard }: { wizard: OnchainReceiveWizard }) {
  const { currentStepId, liveWallets, walletsLoading, selectedWallet, walletId, setWalletId } =
    wizard;

  const walletOptions = useMemo(() => walletComboboxOptions(liveWallets), [liveWallets]);

  if (currentStepId === "WALLET") {
    return (
      <Combobox
        label="Destination wallet"
        value={walletId || null}
        onChange={setWalletId}
        options={walletOptions}
        placeholder="Select a wallet"
        searchPlaceholder="Search wallets"
        icon={<WalletIcon className="size-5 shrink-0 text-text-low" />}
        isLoading={walletsLoading}
      />
    );
  }

  return <WalletReceiveCard address={selectedWallet?.publicKey ?? ""} />;
}
