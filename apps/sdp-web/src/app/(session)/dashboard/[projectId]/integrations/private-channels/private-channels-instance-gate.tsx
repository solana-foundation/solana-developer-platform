"use client";

import type { PrivateChannelInstance } from "@sdp/types/private-channels";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import ProjectNotFound from "@/app/(session)/dashboard/[projectId]/not-found";
import { usePrivateChannelInstance } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { PrivateChannelsLoadError } from "./private-channels-load-error";
import { PRIVATE_CHANNELS_SETUP_PATH } from "./private-channels-routes";

/** Replaces the address once mounted; the caller renders its skeleton meanwhile. */
export function PrivateChannelsRedirect({ path }: { path: string }) {
  const router = useRouter();
  const target = useProjectHref()(path);
  useEffect(() => {
    router.replace(target);
  }, [router, target]);
  return null;
}

/**
 * Renders `children` with the Project's instance once it is the one this page needs.
 *
 * - `"active"`: any active instance; without one the page sends the user to setup.
 * - `{ instanceId }`: the instance the URL names, else not found. `requireActive` also turns
 *   away a disconnected one.
 */
export function PrivateChannelsInstanceGate({
  match,
  skeleton,
  children,
}: {
  match: "active" | { instanceId: string; requireActive: boolean };
  skeleton: ReactNode;
  children: (instance: PrivateChannelInstance) => ReactNode;
}) {
  const { data: instance, error, mutate } = usePrivateChannelInstance(true);
  if (instance === undefined) {
    return error ? (
      <PrivateChannelsLoadError message={error.message} onRetry={() => void mutate()} />
    ) : (
      skeleton
    );
  }
  if (match === "active") {
    if (instance === null || !instance.isActive) {
      return (
        <>
          <PrivateChannelsRedirect path={PRIVATE_CHANNELS_SETUP_PATH} />
          {skeleton}
        </>
      );
    }
    return children(instance);
  }
  if (
    instance === null ||
    instance.id !== match.instanceId ||
    (match.requireActive && !instance.isActive)
  ) {
    return <ProjectNotFound />;
  }
  return children(instance);
}
