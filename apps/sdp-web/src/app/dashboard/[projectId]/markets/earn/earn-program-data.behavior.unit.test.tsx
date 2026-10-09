// @vitest-environment jsdom
import type { EarnVaultPosition } from "@sdp/types";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEarnVaultPositions } from "./earn-program-data";

const position: EarnVaultPosition = {
  id: "position",
  provider: "kamino",
  providerReference: "vault",
  custodyWalletId: "wallet",
  tokenMint: "mint",
  shareMint: "shares",
  label: "Vault",
  createdAt: "2026-10-01T00:00:00Z",
  closedAt: null,
  tokenValue: "10",
  shares: "10",
  feeSponsored: false,
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}
    >
      {children}
    </SWRConfig>
  );
}

/** Each request stays open until the test answers it. */
function stubPositionReads() {
  const requests: { url: string; answer: (status?: number) => void }[] = [];
  const fetchMock = vi.fn(
    (input: RequestInfo | URL) =>
      new Promise<Response>((resolve) => {
        const url = String(input);
        const ids =
          new URL(url, "https://sdp.test").searchParams.get("afterMovementIds")?.split(",") ?? [];
        requests.push({
          url,
          answer: (status = 200) =>
            resolve(
              status === 200
                ? Response.json({
                    data: {
                      positions: [position],
                      hasMore: false,
                      nextCursor: null,
                      ...(ids.length > 0
                        ? { balanceReadContext: { afterMovementIds: ids, minimumSlot: 101 } }
                        : {}),
                    },
                  })
                : Response.json({ error: { message: "Provider unavailable" } }, { status })
            ),
        });
      })
  );
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requests };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("shared vault position reads", () => {
  it("joins the poll and identical refreshes onto one in-flight read", async () => {
    const { fetchMock, requests } = stubPositionReads();
    const { result } = renderHook(() => useEarnVaultPositions(), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    let first: Promise<unknown> = Promise.resolve();
    let second: Promise<unknown> = Promise.resolve();
    act(() => {
      first = result.current.refresh();
      second = result.current.refresh();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => requests[0]?.answer());
    const [firstRead, secondRead] = await Promise.all([first, second]);
    expect(firstRead).toBe(secondRead);
    expect(result.current.positions).toEqual([position]);
  });

  it("never lets a floored refresh join an unfloored read", async () => {
    const { fetchMock, requests } = stubPositionReads();
    const { result } = renderHook(() => useEarnVaultPositions(), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    let floored: Promise<unknown> = Promise.resolve();
    act(() => {
      floored = result.current.refresh(["movement"]);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requests[1]?.url).toContain("afterMovementIds=movement");
    let repeat: Promise<unknown> = Promise.resolve();
    act(() => {
      repeat = result.current.refresh(["movement"]);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      requests[0]?.answer();
      requests[1]?.answer();
    });
    await expect(floored).resolves.toMatchObject({ afterMovementIds: ["movement"] });
    await expect(repeat).resolves.toBe(await floored);
  });

  it("starts a fresh read once the shared one settles", async () => {
    const { fetchMock, requests } = stubPositionReads();
    const { result } = renderHook(() => useEarnVaultPositions(), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => requests[0]?.answer());
    let next: Promise<unknown> = Promise.resolve();
    act(() => {
      next = result.current.refresh();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => requests[1]?.answer());
    await expect(next).resolves.toMatchObject({ positions: [position] });
  });

  it("rejects every joiner of a failed read and does not reuse it", async () => {
    const { fetchMock, requests } = stubPositionReads();
    const { result } = renderHook(() => useEarnVaultPositions(), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    let joined: Promise<unknown> = Promise.resolve();
    act(() => {
      joined = result.current.refresh();
    });
    const settled = joined.then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : "rejected")
    );
    await act(async () => requests[0]?.answer(503));
    await expect(settled).resolves.toBe("Provider unavailable");
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    act(() => {
      void result.current.refresh().catch(() => undefined);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => requests[1]?.answer());
  });
});
