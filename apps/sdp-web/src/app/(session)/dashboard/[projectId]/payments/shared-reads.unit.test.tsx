// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ISSUANCE_MAX_PAGE_SIZE } from "@/app/(session)/dashboard/[projectId]/issuance/issuance-list-query";
import { PaymentsDemoProvider } from "@/lib/payments-demo/payments-demo-context";
import { sentDashboardReads, stubDashboardFetch } from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { SANDBOX_PROJECT } from "@/test/projects";
import { useIssuedTokens } from "./shared-reads";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const FIRST_PAGE_URL = `/api/dashboard/issuance/tokens?page=1&pageSize=${ISSUANCE_MAX_PAGE_SIZE}`;
const SECOND_PAGE_URL = `/api/dashboard/issuance/tokens?page=2&pageSize=${ISSUANCE_MAX_PAGE_SIZE}`;
const FIRST_PAGE = {
  data: [
    {
      id: "tok_test_one",
      mintAddress: "MintOne1111111111111111111111111111111111111",
      symbol: "ONE",
      imageUrl: "https://assets.test/one.png",
    },
    { id: "tok_test_draft", mintAddress: null, symbol: "DRAFT", imageUrl: null },
  ],
  total: ISSUANCE_MAX_PAGE_SIZE + 4,
  hasMore: true,
};
const SECOND_PAGE = {
  data: [
    { id: "", mintAddress: "MintTwo2222222222222222222222222222222222222", symbol: "TWO" },
    { id: "tok_test_unminted", mintAddress: "", symbol: "EMPTY", imageUrl: null },
  ],
  total: ISSUANCE_MAX_PAGE_SIZE + 4,
  hasMore: false,
};

function DemoReads({ children }: { children: ReactNode }) {
  return (
    <DashboardReadsProvider>
      <PaymentsDemoProvider value={true}>{children}</PaymentsDemoProvider>
    </DashboardReadsProvider>
  );
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useIssuedTokens", () => {
  it("reads page after page in the key's mode until the last, keeping only minted tokens", async () => {
    const fetchMock = stubDashboardFetch(({ path }) =>
      Response.json(path === SECOND_PAGE_URL ? SECOND_PAGE : FIRST_PAGE)
    );

    const { result } = renderHook(() => useIssuedTokens(true), { wrapper: DemoReads });

    await waitFor(() =>
      expect(result.current.data).toEqual([
        {
          id: "tok_test_one",
          mintAddress: "MintOne1111111111111111111111111111111111111",
          symbol: "ONE",
          imageUrl: "https://assets.test/one.png",
        },
        {
          id: null,
          mintAddress: "MintTwo2222222222222222222222222222222222222",
          symbol: "TWO",
          imageUrl: null,
        },
      ])
    );
    expect(sentDashboardReads(fetchMock)).toEqual([
      { path: FIRST_PAGE_URL, projectId: SANDBOX_PROJECT.id, demo: "1" },
      { path: SECOND_PAGE_URL, projectId: SANDBOX_PROJECT.id, demo: "1" },
    ]);
  });

  it("stops once the pages read cover the listing's total, even while it says there is more", async () => {
    const fetchMock = stubDashboardFetch(() => Response.json(FIRST_PAGE));

    const { result } = renderHook(() => useIssuedTokens(true), { wrapper: DashboardReadsProvider });

    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(sentDashboardReads(fetchMock).map((read) => read.path)).toEqual([
      FIRST_PAGE_URL,
      SECOND_PAGE_URL,
    ]);
  });

  it("sends nothing while disabled", async () => {
    const fetchMock = stubDashboardFetch(() => Response.json(SECOND_PAGE));

    const { result } = renderHook(() => useIssuedTokens(false), {
      wrapper: DashboardReadsProvider,
    });
    await act(() => Promise.resolve());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });
});
