// @vitest-environment jsdom
/**
 * The create request, and above all its idempotency key.
 *
 * The key has to do two opposite things: make a retry of the same request a
 * replay, and make a second trade on identical terms a new request. The
 * server fingerprint guards the key against reuse with different terms; the
 * client's only job is to hand each logical request exactly one key.
 */
import { SPL_TOKEN_PROGRAMS } from "@sdp/types";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EnglishTestI18n } from "../../test-i18n";
import type { DvpCreateRequest } from "./use-dvp-create-submit";
import { useDvpCreateSubmit } from "./use-dvp-create-submit";

// Submitting confirms in words, so the hook needs the catalog they come from.
function withI18n({ children }: { children: ReactNode }) {
  return <EnglishTestI18n>{children}</EnglishTestI18n>;
}

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

const T22 = SPL_TOKEN_PROGRAMS["token-2022"];
const WALLET_A = "cwlt_a";
const ADDRESS_A = "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn";
const ADDRESS_B = "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg";
/** The project every submit in this file is reviewed under, unless said otherwise. */
const REVIEWED_PROJECT = "project_a";

function request(overrides: Partial<DvpCreateRequest> = {}): DvpCreateRequest {
  return {
    parties: {
      a: { ref: { walletId: WALLET_A }, address: ADDRESS_A },
      b: { ref: { address: ADDRESS_B }, address: ADDRESS_B },
    },
    amountA: "1000",
    amountB: "2000",
    expiry: "2027-01-01T23:59",
    mintA: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
    mintB: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
    refString: "",
    tokenProgramA: T22,
    tokenProgramB: T22,
    // Empty is the ordinary trade: each party is paid at its own address.
    userASettlementDestination: "",
    userBSettlementDestination: "",
    ...overrides,
  };
}

/** Submits once and reports the request that went out. */
async function requestFor(overrides: Partial<DvpCreateRequest> = {}): Promise<{
  idempotencyKey: string;
  reviewedProject: string;
  body: Record<string, unknown>;
}> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: { trade: { id: "dvp_1", createSignature: "sig_create" } } }),
  });
  vi.stubGlobal("fetch", fetchMock);

  const { result } = renderHook(() => useDvpCreateSubmit("devnet", REVIEWED_PROJECT), {
    wrapper: withI18n,
  });
  await act(async () => {
    await result.current.submit(request(overrides));
  });

  const call = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string>; body?: string };
  return {
    idempotencyKey: call.headers?.["Idempotency-Key"] ?? "",
    reviewedProject: call.headers?.["x-sdp-reviewed-project-id"] ?? "",
    body: call.body ? (JSON.parse(call.body) as Record<string, unknown>) : {},
  };
}

describe("useDvpCreateSubmit wire shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the party slots as their wire refs, exactly", async () => {
    const { body } = await requestFor();

    expect(body.partyA).toEqual({ walletId: WALLET_A });
    expect(body.partyB).toEqual({ address: ADDRESS_B });
  });

  it("sends a counterparty slot as its account id", async () => {
    const { body } = await requestFor({
      parties: {
        a: { ref: { counterpartyAccountId: "cpa_1" }, address: ADDRESS_A },
        b: { ref: { address: ADDRESS_B }, address: ADDRESS_B },
      },
    });

    expect(body.partyA).toEqual({ counterpartyAccountId: "cpa_1" });
  });

  it("omits empty settlement destinations rather than sending empty strings", async () => {
    const { body } = await requestFor();

    expect(body).not.toHaveProperty("userASettlementDestination");
    expect(body).not.toHaveProperty("userBSettlementDestination");
  });

  // APE-693. The reviewed project rides with the submit so the route can refuse
  // to forward a trade whose terms were reviewed under a different one.
  it("presents the project the submit was reviewed under", async () => {
    const { reviewedProject } = await requestFor();

    expect(reviewedProject).toBe(REVIEWED_PROJECT);
  });
});

describe("useDvpCreateSubmit idempotency key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function keyOf(fetchMock: ReturnType<typeof vi.fn>, call: number): string {
    const init = fetchMock.mock.calls[call]?.[1] as { headers?: Record<string, string> };
    return init.headers?.["Idempotency-Key"] ?? "";
  }

  it("is well formed", async () => {
    expect((await requestFor()).idempotencyKey).toMatch(/^dvp-create-[0-9a-f]{32}$/);
  });

  // A server error can arrive after the first attempt started broadcasting;
  // only a replay under the same key can find out what became of it.
  it.each([
    ["no response", () => vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))],
    [
      "a server error",
      () =>
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          json: async () => ({ error: { message: "boom" } }),
        }),
    ],
    [
      "a rejection",
      () =>
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          json: async () => ({ error: { message: "no" } }),
        }),
    ],
    // The trade may exist, but nothing readable says which. The same key makes
    // the next press return that trade rather than draw a second one.
    [
      "a success answer that cannot be read",
      () =>
        vi.fn().mockResolvedValue({
          ok: true,
          status: 201,
          json: async () => ({ data: {} }),
        }),
    ],
  ])("reuses the key after %s, so the retry replays", async (_label, mockFetch) => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDvpCreateSubmit("devnet", REVIEWED_PROJECT), {
      wrapper: withI18n,
    });
    await act(async () => {
      await result.current.submit(request());
    });
    await act(async () => {
      await result.current.submit(request());
    });

    expect(keyOf(fetchMock, 1)).toBe(keyOf(fetchMock, 0));
  });

  it("rotates the key once a trade was created, so identical terms make a second trade", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { trade: { id: "dvp_1", createSignature: "sig_create" } } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDvpCreateSubmit("devnet", REVIEWED_PROJECT), {
      wrapper: withI18n,
    });
    await act(async () => {
      await result.current.submit(request());
    });
    await act(async () => {
      await result.current.submit(request());
    });

    expect(keyOf(fetchMock, 1)).not.toBe(keyOf(fetchMock, 0));
  });

  // APE-693. A key drawn for one project must never be presented under a
  // sibling: the create would replay (or mint) under the wrong project's
  // custody and sponsorship. A changed project mints a fresh key.
  it("mints a fresh key when the reviewed project changes, and presents the new one", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: "boom" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(
      ({ project }) => useDvpCreateSubmit("devnet", project),
      { initialProps: { project: "project_a" }, wrapper: withI18n }
    );
    // Fails, so the key is kept for project_a.
    await act(async () => {
      await result.current.submit(request());
    });
    rerender({ project: "project_b" });
    await act(async () => {
      await result.current.submit(request());
    });

    const headersOf = (call: number): Record<string, string> =>
      (fetchMock.mock.calls[call]?.[1] as { headers?: Record<string, string> } | undefined)
        ?.headers ?? {};
    expect(headersOf(0)["x-sdp-reviewed-project-id"]).toBe("project_a");
    expect(headersOf(1)["x-sdp-reviewed-project-id"]).toBe("project_b");
    expect(keyOf(fetchMock, 1)).not.toBe(keyOf(fetchMock, 0));
  });
});

describe("useDvpCreateSubmit confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("says an unreadable success answer is unconfirmed, and stays on the form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      })
    );
    const { result } = renderHook(() => useDvpCreateSubmit("devnet", REVIEWED_PROJECT), {
      wrapper: withI18n,
    });
    await act(async () => {
      await result.current.submit(request());
    });

    expect(result.current.error).toBe(
      "The trade may have been created, but SDP couldn't read the answer. Press Create again to open it; it won't create a second one."
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  // A refusal whose body is not the error envelope still says something true.
  it("names the status when a refusal carries no readable message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => "<html>" })
    );
    const { result } = renderHook(() => useDvpCreateSubmit("devnet", REVIEWED_PROJECT), {
      wrapper: withI18n,
    });
    await act(async () => {
      await result.current.submit(request());
    });

    expect(result.current.error).toBe("Request failed (502).");
  });

  // A refusal the proxy names carries a code so the form can say it in the
  // reader's language; relaying the message would show English to everyone.
  it("names a project-changed refusal in the catalog's own words", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            message: "The selected project changed since this trade was reviewed.",
            details: { reason: "dvp_create_reviewed_project_mismatch" },
          },
        }),
      })
    );
    const { result } = renderHook(() => useDvpCreateSubmit("devnet", REVIEWED_PROJECT), {
      wrapper: withI18n,
    });
    await act(async () => {
      await result.current.submit(request());
    });

    expect(result.current.error).toBe(
      "The selected project changed since this trade was reviewed, so it can't be submitted. Review it under the current project and create it again."
    );
  });

  // The no-selection refusal is named by the proxy too, so it is also said in
  // the reader's language rather than relayed.
  it("names a no-project-selected refusal in the catalog's own words", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            message: "Selected project required",
            details: { reason: "dvp_create_selected_project_required" },
          },
        }),
      })
    );
    const { result } = renderHook(() => useDvpCreateSubmit("devnet", REVIEWED_PROJECT), {
      wrapper: withI18n,
    });
    await act(async () => {
      await result.current.submit(request());
    });

    expect(result.current.error).toBe(
      "No project is selected right now, so this trade can't be submitted. Choose a project and create it again."
    );
  });

  // A refusal without a known code is relayed as sent — the codes are only for
  // refusals this form can name.
  it("relays an unnamed refusal's own message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: "Selected project required" } }),
      })
    );
    const { result } = renderHook(() => useDvpCreateSubmit("devnet", REVIEWED_PROJECT), {
      wrapper: withI18n,
    });
    await act(async () => {
      await result.current.submit(request());
    });

    expect(result.current.error).toBe("Selected project required");
  });

  // The create is SDP's own broadcast, so the toast reporting it links it.
  it("links the create transaction from the toast and opens the new trade", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await requestFor();

    expect(push).toHaveBeenCalledWith("/dashboard/markets/dvp/dvp_1");
    const [, options] = vi.mocked(toast.success).mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(options.action.label).toBe("View transaction");
    options.action.onClick();
    expect(open).toHaveBeenCalledWith(
      "https://explorer.solana.com/tx/sig_create?cluster=devnet",
      "_blank",
      "noopener,noreferrer"
    );
  });
});
