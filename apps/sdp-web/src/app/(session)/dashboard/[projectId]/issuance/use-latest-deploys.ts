"use client";

import {
  isInFlightTokenTransactionStatus,
  isLandedTokenTransactionStatus,
  TOKEN_TRANSACTION_STATUSES,
} from "@sdp/types/tokens";
import { useEffect, useMemo, useRef } from "react";
import { z } from "zod";
import type { DashboardRequestKey } from "@/lib/dashboard-request-key";
import {
  readDashboardRequest,
  useDashboardKeyScope,
  useDashboardSWR,
  useInvalidateDashboardReads,
} from "@/lib/dashboard-swr";
import { issuanceQueryKeys } from "./issuance-query-key";
import type { DeployAttemptStatus } from "./issuance-token-state";

/** How often the list re-reads deploys while one is still on its way. */
const DEPLOY_POLL_MS = 5000;

export type LatestDeploys = Readonly<Record<string, DeployAttemptStatus | null>>;

interface UndeployedToken {
  id: string;
  mintAddress: string | null;
  deployedAt: string | null;
}

const isUndeployed = (token: UndeployedToken) => !(token.mintAddress || token.deployedAt);

const inFlight = (status: DeployAttemptStatus | null | undefined) =>
  status ? isInFlightTokenTransactionStatus(status) : false;

const landed = (status: DeployAttemptStatus | null | undefined) =>
  status ? isLandedTokenTransactionStatus(status) : false;

const deployTransactionsResponseSchema = z.object({
  data: z.array(z.object({ createdAt: z.string(), status: z.enum(TOKEN_TRANSACTION_STATUSES) })),
});

type DeployTransaction = z.infer<typeof deployTransactionsResponseSchema>["data"][number];

/** One token's latest deploy transaction status; null when it has none or the read failed. */
async function readLatestDeploy(key: DashboardRequestKey): Promise<DeployAttemptStatus | null> {
  try {
    const body = await readDashboardRequest(key, deployTransactionsResponseSchema);
    const latest = body.data.reduce<DeployTransaction | null>(
      (newest, transaction) =>
        newest === null || transaction.createdAt > newest.createdAt ? transaction : newest,
      null
    );
    return latest ? latest.status : null;
  } catch {
    return null;
  }
}

async function readLatestDeploys(key: DashboardRequestKey): Promise<LatestDeploys> {
  const scope = { projectId: key[0], mode: key[1] };
  const joinedTokenIds = key[3]?.tokenIds;
  if (typeof joinedTokenIds !== "string") {
    throw new Error("The latest-deploys read was given a key without token ids");
  }
  const tokenIds = joinedTokenIds.split(",");
  const statuses = await Promise.all(
    tokenIds.map((tokenId) =>
      readLatestDeploy(issuanceQueryKeys.latestDeployOf(scope, { tokenId }))
    )
  );
  return Object.fromEntries(tokenIds.map((id, index) => [id, statuses[index] ?? null]));
}

/**
 * The latest deploy of every token on the page that has no mint yet, which is what tells a
 * draft from a deploy in flight or one that failed: the stored token says only "not
 * deployed". Re-reads while a deploy is in flight, and once one lands refreshes the list so
 * the row picks up its mint and deploy date.
 *
 * @param tokens - The page's rows.
 * @returns Each undeployed row's latest deploy status, by token id.
 */
export function useLatestDeploys(tokens: readonly UndeployedToken[]): LatestDeploys {
  const { projectId, mode } = useDashboardKeyScope();
  const invalidateReads = useInvalidateDashboardReads();
  const ids = useMemo(
    () =>
      tokens
        .filter(isUndeployed)
        .map((token) => token.id)
        .sort(),
    [tokens]
  );
  const { data } = useDashboardSWR(
    ids.length > 0 ? issuanceQueryKeys.latestDeploys({ projectId, mode }, { tokenIds: ids }) : null,
    readLatestDeploys,
    {
      keepPreviousData: true,
      revalidateOnFocus: false,
      refreshInterval: (latest) =>
        latest && Object.values(latest).some(inFlight) ? DEPLOY_POLL_MS : 0,
    }
  );

  // A deploy landed on a row the list still holds as undeployed: re-read the list once.
  const refreshedFor = useRef(new Set<string>());
  useEffect(() => {
    if (!data) return;
    const fresh = ids.filter((id) => landed(data[id]) && !refreshedFor.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) refreshedFor.current.add(id);
    void invalidateReads(issuanceQueryKeys.isTokensKey);
  }, [data, ids, invalidateReads]);

  return data ?? {};
}
