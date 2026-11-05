"use client";

import { PrivateChannelsLoadError } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-load-error";
import { usePrivateChannelsCustodyWallets } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-reads";
import { PrivateChannelsPrincipalCreateSkeleton } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-route-skeletons";
import { PrincipalCreatePage } from "./principal-create-page";

export function PrincipalCreateSection() {
  const { data: wallets, error, mutate } = usePrivateChannelsCustodyWallets();
  if (wallets !== undefined) return <PrincipalCreatePage wallets={wallets} />;
  if (error === undefined) return <PrivateChannelsPrincipalCreateSkeleton />;
  return (
    <div className="mx-auto w-full max-w-xl">
      <PrivateChannelsLoadError message={error.message} onRetry={() => void mutate()} />
    </div>
  );
}
