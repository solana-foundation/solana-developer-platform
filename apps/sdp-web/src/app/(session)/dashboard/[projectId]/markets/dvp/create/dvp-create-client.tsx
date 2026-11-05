"use client";

import { DvpCreateSkeleton } from "@/app/(session)/dashboard/[projectId]/markets/markets-route-skeletons";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { useDvpCreateContext } from "./dvp-create.data";
import { DvpCreateWorkspace } from "./dvp-create-workspace";

/**
 * Supplies the active project's cluster and the form's options to the form.
 *
 * Split out so the form itself stays a pure function of its props: the cluster
 * decides which stablecoin mints exist, and reading it from context inside the
 * form would make the form untestable without the whole dashboard workspace.
 */
export function DvpCreateClient() {
  const cluster = useSolanaCluster();
  const { context, retry } = useDvpCreateContext();
  if (context === undefined) {
    return <DvpCreateSkeleton />;
  }
  return <DvpCreateWorkspace cluster={cluster} context={context} onRetryContext={retry} />;
}
