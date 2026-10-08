import { afterEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";
import { dashboardFetch, dashboardRequest } from "./dashboard-fetch";
import { resetIdempotencyKeyStoresForTests } from "./idempotency-key-store";

function noContentFetchMock() {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 })
  );
}

function sentHeaders(fetchMock: ReturnType<typeof noContentFetchMock>): Headers {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
}

afterEach(() => {
  restoreWindowLocation();
  vi.unstubAllGlobals();
  resetIdempotencyKeyStoresForTests();
});

describe("dashboardFetch", () => {
  it("merges explicitly supplied headers with the JSON content type", async () => {
    setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/markets/earn`);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: { ok: true } }), {
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await dashboardFetch("/api/test", {
      method: "POST",
      headers: { "Idempotency-Key": "deposit-key" },
      body: { amount: "1" },
    });

    const options = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(options?.headers);
    expect(headers.get("Idempotency-Key")).toBe("deposit-key");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(options?.body).toBe(JSON.stringify({ amount: "1" }));
  });

  it("does not overwrite an explicitly selected content type", async () => {
    setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/custody`);
    const fetchMock = noContentFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await dashboardFetch("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/merge-patch+json" },
      body: { enabled: true },
    });

    expect(sentHeaders(fetchMock).get("Content-Type")).toBe("application/merge-patch+json");
  });

  it("sends the project in the tab's URL", async () => {
    setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/payments/transfers`);
    const fetchMock = noContentFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await dashboardFetch("/api/dashboard/payments/transfers", {});

    expect(sentHeaders(fetchMock).get("x-project-id")).toBe(SANDBOX_PROJECT.id);
  });
});

describe("dashboardRequest", () => {
  it("sends the project in the tab's URL over a caller-supplied project header", async () => {
    setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}`);
    const fetchMock = noContentFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await dashboardRequest("/api/dashboard/home/activity", {
      headers: { "x-project-id": "prj_test_production" },
    });

    expect(sentHeaders(fetchMock).get("x-project-id")).toBe(SANDBOX_PROJECT.id);
  });

  it("sends no project header outside a project-scoped URL", async () => {
    setWindowPathname("/dashboard/payments");
    const fetchMock = noContentFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await dashboardRequest("/api/dashboard/payments/transfers", {});

    expect(sentHeaders(fetchMock).has("x-project-id")).toBe(false);
  });
});

describe("dashboardRequest Idempotency-Key per user action (HOO-1918)", () => {
  const PATH = "/api/dashboard/payments/recurring-payments";

  function statusFetchMock(...statuses: number[]) {
    return vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("{}", { status: statuses.shift() ?? 201 })
    );
  }

  function keyOfCall(fetchMock: ReturnType<typeof statusFetchMock>, index: number) {
    return new Headers(fetchMock.mock.calls[index]?.[1]?.headers).get("Idempotency-Key");
  }

  function submit(body = '{"amount":"1"}') {
    return dashboardRequest(PATH, { method: "POST", body });
  }

  it("reuses the key across a retry after a 5xx, and retires it after success", async () => {
    setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const fetchMock = statusFetchMock(502, 201, 201);
    vi.stubGlobal("fetch", fetchMock);

    await submit();
    await submit();
    await submit();

    const [failed, retried, next] = [0, 1, 2].map((index) => keyOfCall(fetchMock, index));
    expect(failed).toMatch(/^[0-9a-f-]{36}$/);
    expect(retried).toBe(failed);
    expect(next).not.toBe(retried);
  });

  it("retires the key once a 5xx comes back as a replay, so the next submit is new", async () => {
    setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const responses = [
      new Response("{}", { status: 500 }),
      new Response("{}", { status: 500, headers: { "Idempotent-Replayed": "true" } }),
      new Response("{}", { status: 201 }),
    ];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        responses.shift() ?? new Response("{}", { status: 201 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await submit();
    await submit();
    await submit();

    const keys = [0, 1, 2].map((index) =>
      new Headers(fetchMock.mock.calls[index]?.[1]?.headers).get("Idempotency-Key")
    );
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("holds the key when the request never got an answer", async () => {
    setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const fetchMock = vi
      .fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response("{}", { status: 201 })
      )
      .mockRejectedValueOnce(new TypeError("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submit()).rejects.toThrow("network down");
    await submit();

    expect(keyOfCall(fetchMock, 1)).toBe(keyOfCall(fetchMock, 0));
  });

  it("does not let one caller's abort cancel the request another caller joined", async () => {
    setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    let respond: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const aborted = dashboardRequest(PATH, {
      method: "POST",
      body: '{"amount":"1"}',
      signal: controller.signal,
    });
    const joined = submit();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    respond(new Response("{}", { status: 201 }));

    await expect(aborted).rejects.toBeDefined();
    expect((await joined).status).toBe(201);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeUndefined();
  });

  it("joins a double submit of the same action into one request", async () => {
    setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const fetchMock = statusFetchMock(201);
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([submit(), submit()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await first.text()).toBe("{}");
    expect(await second.text()).toBe("{}");
  });

  it("gives a different action its own key", async () => {
    setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const fetchMock = statusFetchMock(502, 502);
    vi.stubGlobal("fetch", fetchMock);

    await submit('{"amount":"1"}');
    await submit('{"amount":"2"}');

    expect(keyOfCall(fetchMock, 0)).not.toBe(keyOfCall(fetchMock, 1));
  });

  it("leaves a caller-chosen key, reads and other modules alone", async () => {
    setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const fetchMock = statusFetchMock(201, 200, 201);
    vi.stubGlobal("fetch", fetchMock);

    await dashboardRequest(PATH, {
      method: "POST",
      headers: { "Idempotency-Key": "own-key" },
      body: "{}",
    });
    await dashboardRequest(PATH, { method: "GET" });
    await dashboardRequest("/api/dashboard/payments/ramps/quote", { method: "POST", body: "{}" });

    expect(keyOfCall(fetchMock, 0)).toBe("own-key");
    expect(keyOfCall(fetchMock, 1)).toBeNull();
    expect(keyOfCall(fetchMock, 2)).toBeNull();
  });
});
