// @vitest-environment jsdom
import type { EarnVaultPosition } from "@sdp/types/earn";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { earnCoreClient } from "@/lib/earn-core-data";
import { useEarnVaultPositions } from "./earn-data";

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
        const page = {
          positions: [
            { ...position, source: { walletId: position.custodyWalletId }, costBasisKnown: true },
          ],
          hasMore: false,
          nextCursor: null,
        };
        // A read naming movements answers with the context that proves them.
        const data =
          ids.length > 0
            ? { ...page, balanceReadContext: { afterMovementIds: ids, minimumSlot: 101 } }
            : page;
        requests.push({
          url,
          answer: (status = 200) =>
            resolve(
              status === 200
                ? Response.json({ data })
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
  vi.restoreAllMocks();
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
    expect(result.current.positions).toMatchObject([position]);
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

function corePosition(id: string, value: string, movementId: string, slot: number) {
  return {
    ...position,
    id,
    shares: value,
    tokenValue: value,
    source: { walletId: "wallet" },
    costBasisKnown: true,
    balanceReadContext: {
      afterMovementIds: [movementId],
      minimumSlot: slot,
      minimumSlotMovementId: movementId,
    },
  };
}

it("refreshes only the affected position and retains unrelated holdings", async () => {
  const { requests, fetchMock } = stubPositionReads();
  const detail = vi
    .spyOn(earnCoreClient, "position")
    .mockResolvedValue(corePosition("new-position", "20", "deposit", 110));
  const { result } = renderHook(() => useEarnVaultPositions(), { wrapper });
  await waitFor(() => expect(requests).toHaveLength(1));
  await act(async () => requests[0]?.answer());
  await act(async () => {
    await result.current.refresh(["deposit"], new Map([["deposit", "new-position"]]));
  });
  expect(detail).toHaveBeenCalledExactlyOnceWith("new-position", { afterMovementIds: "deposit" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(result.current.positions?.map(({ id, tokenValue }) => [id, tokenValue])).toEqual([
    ["position", "10"],
    ["new-position", "20"],
  ]);
});

it("retains a new deposit when an older collection request finishes last", async () => {
  const { requests } = stubPositionReads();
  const detail = vi
    .spyOn(earnCoreClient, "position")
    .mockResolvedValue(corePosition("new-position", "20", "deposit", 110));
  const { result } = renderHook(() => useEarnVaultPositions(), { wrapper });
  await waitFor(() => expect(requests).toHaveLength(1));
  await act(async () => requests[0]?.answer());
  let full: Promise<unknown> | undefined;
  act(() => {
    full = result.current.refresh();
  });
  await waitFor(() => expect(requests).toHaveLength(2));
  await act(async () => {
    await result.current.refresh(["deposit"], new Map([["deposit", "new-position"]]));
  });
  await act(async () => {
    requests[1]?.answer();
    await full;
  });
  expect(result.current.positions?.find(({ id }) => id === "new-position")?.tokenValue).toBe("20");
  expect(detail).toHaveBeenCalledTimes(1);
});

it("preserves concurrent positions and the stronger slot when same-position responses reverse", async () => {
  const { requests } = stubPositionReads();
  type Detail = Awaited<ReturnType<typeof earnCoreClient.position>>;
  const pending: { ids: string | undefined; resolve: (position: Detail) => void }[] = [];
  vi.spyOn(earnCoreClient, "position").mockImplementation(
    (_id, query) =>
      new Promise<Detail>((resolve) => {
        pending.push({ ids: query?.afterMovementIds, resolve });
      })
  );
  const { result } = renderHook(() => useEarnVaultPositions(), { wrapper });
  await waitFor(() => expect(requests).toHaveLength(1));
  await act(async () => requests[0]?.answer());
  let older: Promise<unknown> | undefined;
  let newer: Promise<unknown> | undefined;
  act(() => {
    older = result.current.refresh(["old"], new Map([["old", "position"]]));
    newer = result.current.refresh(["new"], new Map([["new", "position"]]));
  });
  await act(async () => {
    pending[1]?.resolve({
      ...corePosition("position", "30", "new", 120),
      balanceReadContext: {
        afterMovementIds: ["old", "new"],
        minimumSlot: 120,
        minimumSlotMovementId: "new",
      },
    });
    await newer;
  });
  await act(async () => {
    pending[0]?.resolve(corePosition("position", "20", "old", 110));
    await older;
  });
  expect(result.current.positions?.[0]?.tokenValue).toBe("30");
  await expect(older).resolves.toMatchObject({ minimumSlot: 120 });
});

it("withholds targeted balances when the response lacks movement freshness", async () => {
  const { requests } = stubPositionReads();
  vi.spyOn(earnCoreClient, "position").mockResolvedValue({
    ...corePosition("position", "20", "different", 110),
  });
  const { result } = renderHook(() => useEarnVaultPositions(), { wrapper });
  await waitFor(() => expect(requests).toHaveLength(1));
  await act(async () => requests[0]?.answer());
  await act(async () => {
    await expect(
      result.current.refresh(["deposit"], new Map([["deposit", "position"]]))
    ).rejects.toThrow("confirmation freshness");
  });
  expect(result.current.positions?.[0]?.tokenValue).toBe("10");
});

it("removes a verified closed position without resurrecting it from an older collection", async () => {
  const { requests } = stubPositionReads();
  vi.spyOn(earnCoreClient, "position").mockResolvedValue({
    ...corePosition("position", "0", "exit", 115),
    closedAt: "2026-11-24T00:00:00Z",
  });
  const { result } = renderHook(() => useEarnVaultPositions(), { wrapper });
  await waitFor(() => expect(requests).toHaveLength(1));
  await act(async () => requests[0]?.answer());
  let old: Promise<unknown> | undefined;
  act(() => {
    old = result.current.refresh();
  });
  await act(async () => {
    const read = await result.current.refresh(["exit"], new Map([["exit", "position"]]));
    expect(read).toMatchObject({ positions: [], minimumSlot: 115, afterMovementIds: ["exit"] });
  });
  await act(async () => {
    requests[1]?.answer();
    await old;
  });
  expect(result.current.positions).toEqual([]);
});

it("does not pair fresh cash with a position whose provider hydration is unavailable", async () => {
  const { requests } = stubPositionReads();
  vi.spyOn(earnCoreClient, "position").mockResolvedValue({
    ...corePosition("position", "20", "deposit", 110),
    shares: undefined,
    tokenValue: undefined,
  });
  const { result } = renderHook(() => useEarnVaultPositions(), { wrapper });
  await waitFor(() => expect(requests).toHaveLength(1));
  await act(async () => requests[0]?.answer());
  await act(async () => {
    await expect(
      result.current.refresh(["deposit"], new Map([["deposit", "position"]]))
    ).rejects.toThrow("Position balance is unavailable");
  });
  expect(result.current.positions?.[0]?.tokenValue).toBe("10");
});

it("retains one strongest movement proof per position after many completed operations", async () => {
  const { requests } = stubPositionReads();
  const detail = vi.spyOn(earnCoreClient, "position").mockImplementation(async (_id, query) => {
    const ids = query?.afterMovementIds?.split(",") ?? [];
    const strongest = ids.at(-1);
    if (!strongest) throw new Error("Expected proof IDs");
    return {
      ...corePosition("position", "20", strongest, 110),
      balanceReadContext: {
        afterMovementIds: ids,
        minimumSlot: 110,
        minimumSlotMovementId: strongest,
      },
    };
  });
  const { result } = renderHook(() => useEarnVaultPositions(), { wrapper });
  await waitFor(() => expect(requests).toHaveLength(1));
  await act(async () => requests[0]?.answer());
  for (let i = 0; i < 120; i += 1) {
    await act(async () => {
      await result.current.refresh([`movement-${i}`], new Map([[`movement-${i}`, "position"]]));
    });
  }
  expect(
    detail.mock.calls.every(([, query]) => (query?.afterMovementIds?.split(",").length ?? 0) <= 2)
  ).toBe(true);
  let full: Promise<unknown> | undefined;
  act(() => {
    full = result.current.refresh();
  });
  expect(requests).toHaveLength(2);
  expect(
    new URL(requests[1]?.url ?? "", "https://sdp.test").searchParams.get("afterMovementIds")
  ).toBe("movement-119");
  await act(async () => {
    requests[1]?.answer();
    await full;
  });
});

it("stops starting position groups and proof batches after either reader fails", async () => {
  const { requests } = stubPositionReads();
  type Detail = Awaited<ReturnType<typeof earnCoreClient.position>>;
  let finishSibling: (position: Detail) => void = () => {};
  const sibling = new Promise<Detail>((resolve) => {
    finishSibling = resolve;
  });
  const detail = vi
    .spyOn(earnCoreClient, "position")
    .mockRejectedValueOnce(new Error("Provider unavailable"))
    .mockReturnValueOnce(sibling)
    .mockResolvedValue(corePosition("unexpected", "20", "unexpected", 110));
  const { result } = renderHook(() => useEarnVaultPositions(), { wrapper });
  await waitFor(() => expect(requests).toHaveLength(1));
  await act(async () => requests[0]?.answer());
  const siblingIds = Array.from({ length: 101 }, (_, index) => `sibling-${index}`);
  const ids = ["failed", ...siblingIds, "third", "fourth"];
  const positions = new Map([
    ["failed", "failed-position"],
    ...siblingIds.map((id) => [id, "slow-position"] as const),
    ["third", "third-position"],
    ["fourth", "fourth-position"],
  ]);
  await act(async () => {
    await expect(result.current.refresh(ids, positions)).rejects.toThrow("Provider unavailable");
  });
  expect(detail.mock.calls.map(([id]) => id)).toEqual(["failed-position", "slow-position"]);
  await act(async () => {
    finishSibling({
      ...corePosition("slow-position", "20", "sibling-99", 110),
      balanceReadContext: {
        afterMovementIds: siblingIds.slice(0, 100),
        minimumSlot: 110,
        minimumSlotMovementId: "sibling-99",
      },
    });
    await sibling;
  });
  expect(detail).toHaveBeenCalledTimes(2);
  expect(result.current.positions?.[0]?.tokenValue).toBe("10");
});

it("exposes a failed cold completion refresh through the portfolio error state", async () => {
  const { requests } = stubPositionReads();
  const { result } = renderHook(() => useEarnVaultPositions(), { wrapper });
  await waitFor(() => expect(requests).toHaveLength(1));
  let failure: Promise<unknown> = Promise.resolve();
  act(() => {
    failure = result.current
      .refresh(["deposit"], new Map([["deposit", "new-position"]]))
      .catch((cause) => cause);
  });
  await waitFor(() => expect(requests).toHaveLength(2));
  await act(async () => requests[1]?.answer(503));
  await waitFor(() => expect(requests).toHaveLength(3));
  await act(async () => {
    requests[2]?.answer(503);
    expect(await failure).toBeInstanceOf(Error);
  });
  await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
  expect(result.current.positions).toBeUndefined();
  await act(async () => requests[0]?.answer(503));
});

it("refreshes the full portfolio if completion arrives before the initial collection", async () => {
  const { requests } = stubPositionReads();
  const detail = vi.spyOn(earnCoreClient, "position");
  const { result } = renderHook(() => useEarnVaultPositions(), { wrapper });
  await waitFor(() => expect(requests).toHaveLength(1));
  let refreshing: Promise<unknown> | undefined;
  act(() => {
    refreshing = result.current.refresh(["deposit"], new Map([["deposit", "new-position"]]));
  });
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(detail).not.toHaveBeenCalled();
  await act(async () => {
    requests[1]?.answer();
    await refreshing;
  });
  expect(result.current.positions?.some(({ id }) => id === "position")).toBe(true);
  await act(async () => requests[0]?.answer());
});
