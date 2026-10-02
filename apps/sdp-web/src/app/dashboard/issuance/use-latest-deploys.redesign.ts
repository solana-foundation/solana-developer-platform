"use client";

import type { TokenTransaction } from "@sdp/types";
import { useEffect, useMemo, useRef } from "react";
import useSWR, { useSWRConfig } from "swr";
import type { DeployAttemptStatus } from "./issuance-token-state.redesign";

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
  status === "pending" || status === "processing";

const landed = (status: DeployAttemptStatus | null | undefined) =>
  status === "confirmed" || status === "finalized";

/** One token's latest deploy transaction status; null when it has none or the read failed. */
async function fetchLatestDeploy(tokenId: string): Promise<DeployAttemptStatus | null> {
  try {
    const response = await fetch(
      `/api/dashboard/issuance/tokens/${encodeURIComponent(tokenId)}/transactions?type=deploy&page=1&pageSize=5`
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: TokenTransaction[] };
    const latest = (body.data ?? []).reduce<TokenTransaction | null>(
      (newest, transaction) =>
        newest === null || transaction.createdAt > newest.createdAt ? transaction : newest,
      null
    );
    return latest ? (latest.status as DeployAttemptStatus) : null;
  } catch {
    return null;
  }
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
  const { mutate } = useSWRConfig();
  const ids = useMemo(
    () =>
      tokens
        .filter(isUndeployed)
        .map((token) => token.id)
        .sort(),
    [tokens]
  );
  const { data } = useSWR(
    ids.length > 0 ? (["issuance-latest-deploys", ids] as const) : null,
    async ([, tokenIds]) => {
      const statuses = await Promise.all(tokenIds.map(fetchLatestDeploy));
      return Object.fromEntries(tokenIds.map((id, index) => [id, statuses[index] ?? null]));
    },
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
    void mutate((key) => Array.isArray(key) && key[0] === "issuance-tokens");
  }, [data, ids, mutate]);

  return data ?? {};
}
