import type { EarnStrategy } from "@sdp/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  earnProgramsRefreshInterval,
  fetchEarnProgramDeposits,
  fetchEarnProgramsState,
  fetchEarnStrategies,
  hasPrograms,
} from "./earn-program-data";

const TIMESTAMP = "2026-07-18T09:00:00.000Z";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function strategy(id: string): EarnStrategy {
  return {
    id,
    provider: "ground",
    providerReference: `${id}-ref`,
    name: id,
    sourceKind: "defi",
    depositMints: [USDC],
    apyType: "variable",
    currentApy: "0.05",
    liquidityTerm: "instant",
    status: "active",
    hostCluster: "devnet",
    fundable: true,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

/** Stubs the BFF with a fixed catalogue, paging it the way the API would. */
function stubCatalogue(total: number, pageSize = 100) {
  const all = Array.from({ length: total }, (_, index) => strategy(`s${index}`));
  const calls: string[] = [];

  const fetchMock = vi.fn(async (input: string) => {
    calls.push(input);
    const page = Number(new URL(input, "https://sdp.test").searchParams.get("page") ?? "1");
    const slice = all.slice((page - 1) * pageSize, page * pageSize);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { strategies: slice, total, page, pageSize } }),
    } as unknown as Response;
  });

  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchEarnStrategies", () => {
  it("returns a single short page without asking for a second", async () => {
    const { calls } = stubCatalogue(12);
    const strategies = await fetchEarnStrategies();
    expect(strategies).toHaveLength(12);
    expect(calls).toHaveLength(1);
  });

  it("pages past the API's 100-row cap instead of silently truncating", async () => {
    // The regression this guards: one unpaged request dropped every strategy
    // past the first 100, with no error anywhere.
    const { calls } = stubCatalogue(250);
    const strategies = await fetchEarnStrategies();
    expect(strategies).toHaveLength(250);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("page=1");
    expect(calls[2]).toContain("page=3");
    expect(new Set(strategies.map((entry) => entry.id)).size).toBe(250);
  });

  it("stops on an exactly-full final page rather than fetching an empty one", async () => {
    const { calls } = stubCatalogue(200);
    const strategies = await fetchEarnStrategies();
    expect(strategies).toHaveLength(200);
    expect(calls).toHaveLength(2);
  });

  it("stops on a short page even when the reported total is too high", async () => {
    // A wrong `total` must not spin the loop; the short page is authoritative.
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { strategies: [strategy("only")], total: 9_999, page: 1, pageSize: 100 },
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const strategies = await fetchEarnStrategies();
    expect(strategies).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps the loop when every page stays full and the total never resolves", async () => {
    // Pathological provider/API response: full pages forever. The cap keeps the
    // dashboard from hanging on an unbounded fetch.
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            strategies: Array.from({ length: 100 }, (_, index) => strategy(`x${index}`)),
            total: Number.MAX_SAFE_INTEGER,
            page: 1,
            pageSize: 100,
          },
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchEarnStrategies();
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it("throws with the API's message when a page fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: { message: "Ground is not configured for sandbox mode." } }),
        } as unknown as Response;
      })
    );

    await expect(fetchEarnStrategies()).rejects.toThrow(
      "Ground is not configured for sandbox mode."
    );
  });
});

/**
 * The program-read discrimination is the whole behavioural surface of the
 * multi-program change on the web side, and CI runs none of these files — so
 * without this block the rule has zero automated coverage anywhere.
 */
function stubProgramsResponse(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () => ({ ok: status < 300, status, json: async () => body }) as unknown as Response
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Pages the programs collection the way the API would, at its real page size. */
function stubProgramsPages(all: unknown[], pageSize = 100) {
  const fetchMock = vi.fn(async (input: string) => {
    const params = new URL(input, "https://sdp.test").searchParams;
    const page = Number(params.get("page") ?? "1");
    const size = Number(params.get("pageSize") ?? "20");
    const slice = all.slice((page - 1) * size, page * size);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { programs: slice, total: all.length } }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, pageSize };
}

function programFixture(id: string, status = "ready") {
  return {
    id,
    provider: "ground",
    label: null,
    createdAt: TIMESTAMP,
    wallet: {
      providerWalletRef: `${id}-ref`,
      status,
      balance: { totalUsd: "1", withdrawableUsd: "1", reservedUsd: "0", earnedUsd: "0" },
      positions: [],
      allocations: {},
    },
  };
}

describe("fetchEarnProgramsState", () => {
  it("maps an EMPTY list to no programs, not to an error", async () => {
    stubProgramsResponse(200, { data: { programs: [] } });
    const state = await fetchEarnProgramsState();
    expect(state).toEqual({ kind: "ready", programs: [] });
    expect(hasPrograms(state)).toBe(false);
  });

  it("keeps every program, in the order the API returned them", async () => {
    stubProgramsResponse(200, {
      data: { programs: [programFixture("p1"), programFixture("p2")] },
    });
    const state = await fetchEarnProgramsState();
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(hasPrograms(state)).toBe(true);
    // Order is load-bearing: consumers that track one program across polls rely
    // on the head of this list being stable.
    expect(state.programs.map((program) => program.id)).toEqual(["p1", "p2"]);
  });

  it("maps 503 to unconfigured so the quiet provider notice stays reachable", async () => {
    stubProgramsResponse(503, { error: { message: "provider not configured" } });
    expect(await fetchEarnProgramsState()).toEqual({ kind: "unconfigured" });
  });

  /**
   * A 404 must NOT read as "no programs". A retired path, a typo'd proxy path,
   * or a missing Next route all answer 404, and mapping that to emptiness would
   * show onboarding to a customer whose funds are deployed.
   */
  it("throws on 404 rather than reporting an empty portfolio", async () => {
    stubProgramsResponse(404, { error: { message: "not found" } });
    await expect(fetchEarnProgramsState()).rejects.toThrow("not found");
  });

  it("throws on a server error", async () => {
    stubProgramsResponse(500, { error: { message: "boom" } });
    await expect(fetchEarnProgramsState()).rejects.toThrow("boom");
  });
});

describe("fetchEarnProgramsState pagination", () => {
  /**
   * The regression this pins: a single unpaged request silently truncates the
   * org's programs at the API's page window — and a hidden program is hidden
   * MONEY (totals under-report, its card never renders, its deep links stop
   * resolving). Same rule fetchEarnStrategies already enforces.
   */
  it("fetches every page, not just the first", async () => {
    const all = Array.from({ length: 205 }, (_, index) => programFixture(`p${index}`));
    const { fetchMock } = stubProgramsPages(all);

    const state = await fetchEarnProgramsState();
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.programs).toHaveLength(205);
    expect(state.programs[204]?.id).toBe("p204");
    // 100-per-page over 205 programs = 3 requests.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops after one request when a single page holds everything", async () => {
    const { fetchMock } = stubProgramsPages([programFixture("p0")]);
    const state = await fetchEarnProgramsState();
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.programs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchEarnProgramDeposits (via useEarnProgramDeposits fetcher)", () => {
  /**
   * No 404→empty mapping: the program id always comes from a program resolved
   * through the live list in this org+environment, so a 404 can only be a
   * broken proxy path or a scoping regression — and rendering that as "no
   * deposits yet" on a funded program would mask the bug as calm.
   */
  it("throws on 404 rather than reporting an empty feed", async () => {
    stubProgramsResponse(404, { error: { message: "not found" } });
    await expect(fetchEarnProgramDeposits("prog_1")).rejects.toThrow("not found");
  });
});

describe("earnProgramsRefreshInterval", () => {
  const withStatus = (...statuses: string[]) =>
    ({
      kind: "ready" as const,
      programs: statuses.map((status, index) => programFixture(`p${index}`, status)),
    }) as never;

  it("stops polling when every program is settled", () => {
    expect(earnProgramsRefreshInterval(withStatus("ready", "ready"))).toBe(0);
  });

  it("polls at the FASTEST cadence any single program asks for", () => {
    // A `creating` program among settled ones must still converge on its
    // deposit address; taking the first program's cadence would strand it.
    expect(earnProgramsRefreshInterval(withStatus("ready", "creating"))).toBe(4_000);
    expect(earnProgramsRefreshInterval(withStatus("busy", "creating"))).toBe(4_000);
    expect(earnProgramsRefreshInterval(withStatus("ready", "busy"))).toBe(10_000);
  });

  it("does not poll before the read resolves", () => {
    expect(earnProgramsRefreshInterval(undefined)).toBe(0);
  });
});
