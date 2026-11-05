"use client";

import {
  PrivateChannelsInstanceGate,
  PrivateChannelsRedirect,
} from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-instance-gate";
import { PrivateChannelsLoadError } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-load-error";
import { usePrivateChannelInstance } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-reads";
import { PrivateChannelsSetupSkeleton } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-route-skeletons";
import { privateChannelsSetupPath } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-routes";
import { PrivateChannelsSetupScreen } from "./private-channels-setup-screen";

/** Setup before a connection exists; an active connection is managed at its own address. */
export function PrivateChannelsSetupEntry() {
  const { data: instance, error, mutate } = usePrivateChannelInstance();
  if (instance === undefined) {
    return error ? (
      <PrivateChannelsLoadError message={error.message} onRetry={() => void mutate()} />
    ) : (
      <PrivateChannelsSetupSkeleton />
    );
  }
  if (instance?.isActive) {
    return (
      <>
        <PrivateChannelsRedirect path={privateChannelsSetupPath(instance.id)} />
        <PrivateChannelsSetupSkeleton />
      </>
    );
  }
  return <PrivateChannelsSetupScreen instance={instance} />;
}

export function PrivateChannelsInstanceSetup({ instanceId }: { instanceId: string }) {
  return (
    <PrivateChannelsInstanceGate
      match={{ instanceId, requireActive: false }}
      skeleton={<PrivateChannelsSetupSkeleton />}
    >
      {(instance) => <PrivateChannelsSetupScreen instance={instance} />}
    </PrivateChannelsInstanceGate>
  );
}
