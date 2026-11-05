"use client";

import { PrivateChannelsMovementCard } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-movement-card";
import { WithdrawForm } from "./withdraw-form";

export function WithdrawSection() {
  return (
    <PrivateChannelsMovementCard
      titleKey="DashboardPrivateChannels.withdraw.title"
      descriptionKey="DashboardPrivateChannels.withdraw.description"
    >
      {(wallets, tokens) => <WithdrawForm tokens={tokens} wallets={wallets} />}
    </PrivateChannelsMovementCard>
  );
}
