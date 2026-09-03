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
 */
export function DvpCreateClient({ context }: { context: DvpCreateContext }) {
  return <DvpCreateWorkspace cluster={useSolanaCluster()} context={context} />;
}
