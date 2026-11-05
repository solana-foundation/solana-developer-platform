// @vitest-environment jsdom

import type { TokenTransactionStatus } from "@sdp/types/tokens";
import { renderHook, waitFor } from "@testing-library/react";
import { unstable_serialize, useSWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sentDashboardReads, stubDashboardFetch } from "@/test/dashboard-fetch";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { SANDBOX_PROJECT } from "@/test/projects";
import { issuanceQueryKeys } from "./issuance-query-key";
import { tokenLifecycle } from "./issuance-token-state";
import { useLatestDeploys } from "./use-latest-deploys";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const deploys = {
  deploying: [
    { status: "failed", createdAt: "2026-09-30T10:00:00.000Z" },
    { status: "processing", createdAt: "2026-10-01T10:00:00.000Z" },
  ],
  failed: [{ status: "failed", createdAt: "2026-10-01T10:00:00.000Z" }],
  untouched: [],
} as const satisfies Record<
  string,
  ReadonlyArray<{ status: TokenTransactionStatus; createdAt: string }>
>;

function deployReadUrl(tokenId: string) {
  return `/api/dashboard/issuance/tokens/${tokenId}/transactions?page=1&pageSize=5&type=deploy`;
}

const deployReadAnswers = new Map<string, ReadonlyArray<{ status: string; createdAt: string }>>(
  Object.entries(deploys).map(([tokenId, data]) => [deployReadUrl(tokenId), data])
);

afterEach(() => vi.unstubAllGlobals());

describe("useLatestDeploys", () => {
  it("reads the latest deploy of each row with no mint, one request per row, under one key", async () => {
    const fetchMock = stubDashboardFetch(({ path }) => {
      const data = deployReadAnswers.get(path);
      if (data === undefined) throw new Error(`Unexpected read: ${path}`);
      return Response.json({ data });
    });

    const tokens = [
      { id: "untouched", mintAddress: null, deployedAt: null, status: "pending" },
      { id: "deploying", mintAddress: null, deployedAt: null, status: "pending" },
      { id: "failed", mintAddress: null, deployedAt: null, status: "pending" },
      { id: "live", mintAddress: "Mint111", deployedAt: "2026-09-01T00:00:00Z", status: "active" },
    ];
    const { result } = renderHook(
      () => ({ latest: useLatestDeploys(tokens), cache: useSWRConfig().cache }),
      { wrapper: DashboardReadsProvider }
    );

    await waitFor(() => expect(Object.keys(result.current.latest)).toHaveLength(3));
    expect(sentDashboardReads(fetchMock)).toEqual(
      ["deploying", "failed", "untouched"].map((tokenId) => ({
        path: deployReadUrl(tokenId),
        projectId: SANDBOX_PROJECT.id,
        demo: null,
      }))
    );
    expect(result.current.latest).toEqual({
      deploying: "processing",
      failed: "failed",
      untouched: null,
    });
    const latestDeploysKey = issuanceQueryKeys.latestDeploys(
      { projectId: SANDBOX_PROJECT.id, mode: "live" },
      { tokenIds: ["deploying", "failed", "untouched"] }
    );
    expect([...result.current.cache.keys()]).toEqual([unstable_serialize(latestDeploysKey)]);
    expect(
      tokens.map((token) => tokenLifecycle(token, result.current.latest[token.id] ?? null))
    ).toEqual(["draft", "deploying", "failed", "live"]);
  });

  it("reads nothing when every row is on chain", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(
      () =>
        useLatestDeploys([
          { id: "live", mintAddress: "Mint111", deployedAt: "2026-09-01T00:00:00Z" },
        ]),
      { wrapper: DashboardReadsProvider }
    );
    expect(result.current).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
