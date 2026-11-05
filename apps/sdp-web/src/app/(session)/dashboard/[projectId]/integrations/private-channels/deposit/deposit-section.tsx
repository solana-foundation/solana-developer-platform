"use client";

import { PrivateChannelsMovementCard } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-movement-card";
import { DepositForm } from "./deposit-form";

export function DepositSection() {
  return (
    <PrivateChannelsMovementCard
      titleKey="DashboardPrivateChannels.deposit.title"
      descriptionKey="DashboardPrivateChannels.deposit.description"
    >
      {(wallets, tokens) => <DepositForm tokens={tokens} wallets={wallets} />}
    </PrivateChannelsMovementCard>
  );
}
