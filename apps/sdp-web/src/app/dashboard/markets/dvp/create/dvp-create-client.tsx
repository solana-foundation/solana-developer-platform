"use client";

import { useSolanaCluster } from "@/lib/use-solana-cluster";
import type { DvpCreateContext } from "./dvp-create.data";
import { DvpCreateWorkspace } from "./dvp-create-workspace";

/**
 * Supplies the active project's cluster to the form.
 *
 * Split out so the form itself stays a pure function of its props: the cluster
 * decides which stablecoin mints exist, and reading it from context inside the
 * form would make the form untestable without the whole dashboard workspace.
 *
 * `reviewedProjectId` is the project whose wallets and tokens the server just
 * loaded — the project the trade's terms were reviewed under. The workspace
 * binds its submit to it and invalidates itself when the selection moves.
 */
export function DvpCreateClient({
  context,
  reviewedProjectId,
}: {
  context: DvpCreateContext;
  reviewedProjectId: string;
}) {
  return (
    <DvpCreateWorkspace
      cluster={useSolanaCluster()}
      context={context}
      reviewedProjectId={reviewedProjectId}
    />
  );
}
