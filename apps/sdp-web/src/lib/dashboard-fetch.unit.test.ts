import { afterEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";
import { dashboardFetch, dashboardRequest, setTabShowsDemo } from "./dashboard-fetch";
import { resetIdempotencyKeyStoresForTests, setIdempotencyKeyScope } from "./idempotency-key-store";
import { TAB_DEMO_HEADER_NAME } from "./payments-demo/demo-cookie";

function noContentFetchMock() {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 })
  );
}

function sentHeaders(fetchMock: ReturnType<typeof noContentFetchMock>): Headers {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
}

/**
 * Gives the window a `sessionStorage`: an in-memory one, or one that refuses
 * every write. Returns a switch to start or stop refusing later.
 */
function installSessionStorage(refuseWrites = false): { refuseWrites: boolean } {
  const control = { refuseWrites };
  const entries = new Map<string, string>();
  const storage = {
    getItem: (name: string) => entries.get(name) ?? null,
    setItem: (name: string, value: string) => {
      if (control.refuseWrites) throw new DOMException("quota exceeded", "QuotaExceededError");
      entries.set(name, value);
    },
    removeItem: (name: string) => {
      entries.delete(name);
    },
  };
  Object.defineProperty(window, "sessionStorage", { value: storage, configurable: true });
  return control;
}

/** Puts the tab on `pathname` with working storage, as a browser has. */
function openTab(pathname: string): void {
  setWindowPathname(pathname);
  installSessionStorage();
}

afterEach(() => {
  restoreWindowLocation();
  vi.unstubAllGlobals();
  resetIdempotencyKeyStoresForTests();
  if (typeof window !== "undefined") Reflect.deleteProperty(window, "sessionStorage");
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

/** A dashboard backend answer: JSON, as every backend route returns. */
function jsonResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response("{}", {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("dashboardRequest Idempotency-Key per user action (HOO-1918)", () => {
  const PATH = "/api/dashboard/payments/recurring-payments";

  function statusFetchMock(...statuses: number[]) {
    return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(statuses.shift() ?? 201)
    );
  }

  function keyOfCall(fetchMock: ReturnType<typeof statusFetchMock>, index: number) {
    return new Headers(fetchMock.mock.calls[index]?.[1]?.headers).get("Idempotency-Key");
  }

  function submit(body = '{"amount":"1"}') {
    return dashboardRequest(PATH, { method: "POST", body });
  }

  it("reuses the key across a retry after a 5xx, and retires it after success", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
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
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const responses = [
      jsonResponse(500),
      jsonResponse(500, { "Idempotent-Replayed": "true" }),
      jsonResponse(201),
    ];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        responses.shift() ?? jsonResponse(201)
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

  it("reports a replayed failure to dashboardFetch's caller", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/requests`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(400, { "Idempotent-Replayed": "true" }))
    );
    const result = await dashboardFetch("/api/dashboard/payments/requests", {
      method: "POST",
      body: { amount: "1" },
    });
    expect(result).toMatchObject({ ok: false, status: 400, replayed: true });
  });

  it("holds the key when the request never got an answer", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const fetchMock = vi
      .fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(201))
      .mockRejectedValueOnce(new TypeError("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submit()).rejects.toThrow("network down");
    await submit();

    expect(keyOfCall(fetchMock, 1)).toBe(keyOfCall(fetchMock, 0));
  });

  // Greptile (#2252): an expired session's 401 settles nothing about the
  // unanswered attempt before it, so signing in and retrying reuses its key.
  it("keeps an unanswered attempt's key through a later refusal", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const fetchMock = vi
      .fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(201))
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(jsonResponse(401));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submit()).rejects.toThrow("network down");
    expect((await submit()).status).toBe(401);
    await submit();

    expect(keyOfCall(fetchMock, 1)).toBe(keyOfCall(fetchMock, 0));
    expect(keyOfCall(fetchMock, 2)).toBe(keyOfCall(fetchMock, 0));
  });

  // Greptile (#2266): an expired session's redirect to sign-in comes back as an
  // HTML 200 that says nothing about the write, so it keeps the key.
  it("keeps the key when the answer is a followed redirect, not the backend's", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const signIn = new Response("<html>sign in</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    Object.defineProperty(signIn, "redirected", { value: true });
    const fetchMock = vi
      .fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(201))
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(signIn);
    vi.stubGlobal("fetch", fetchMock);

    await expect(submit()).rejects.toThrow("network down");
    await submit();
    await submit();

    expect(keyOfCall(fetchMock, 1)).toBe(keyOfCall(fetchMock, 0));
    expect(keyOfCall(fetchMock, 2)).toBe(keyOfCall(fetchMock, 0));
  });

  it("keeps the key on a plain refusal, which runs again, and retires it on a 422", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const fetchMock = statusFetchMock(400, 422, 201);
    vi.stubGlobal("fetch", fetchMock);

    await submit();
    await submit();
    await submit();

    expect(keyOfCall(fetchMock, 1)).toBe(keyOfCall(fetchMock, 0));
    expect(keyOfCall(fetchMock, 2)).not.toBe(keyOfCall(fetchMock, 1));
  });

  const conflict = (code: string) =>
    new Response(JSON.stringify({ error: { code, message: "conflict" } }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });

  // A money movement never mints a fresh key while the original may have run.
  it("keeps a money route's key through a 409 in flight or with an unknown outcome", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const responses = [
      conflict("IDEMPOTENCY_KEY_IN_FLIGHT"),
      conflict("IDEMPOTENCY_KEY_OUTCOME_UNKNOWN"),
      jsonResponse(201),
    ];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        responses.shift() ?? jsonResponse(201)
    );
    vi.stubGlobal("fetch", fetchMock);

    await submit();
    await submit();
    await submit();

    expect(keyOfCall(fetchMock, 1)).toBe(keyOfCall(fetchMock, 0));
    expect(keyOfCall(fetchMock, 2)).toBe(keyOfCall(fetchMock, 1));
  });

  it("retires another route's key on a 409 whose outcome is unknown", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const responses = [conflict("IDEMPOTENCY_KEY_OUTCOME_UNKNOWN"), jsonResponse(201)];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        responses.shift() ?? jsonResponse(201)
    );
    vi.stubGlobal("fetch", fetchMock);
    const send = () =>
      dashboardRequest("/api/dashboard/payments/counterparties", {
        method: "POST",
        body: '{"name":"a"}',
      });

    await send();
    await send();

    expect(keyOfCall(fetchMock, 1)).not.toBe(keyOfCall(fetchMock, 0));
  });

  // Greptile (#2333): a create whose 2xx body was not the JSON it claimed lost
  // its key, so the retry ran again under a new one.
  it("keeps the key when a success's body is not readable JSON", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const responses = [
      new Response("{", { status: 201, headers: { "content-type": "application/json" } }),
      jsonResponse(201),
    ];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        responses.shift() ?? jsonResponse(201)
    );
    vi.stubGlobal("fetch", fetchMock);

    await submit();
    await submit();

    expect(keyOfCall(fetchMock, 1)).toBe(keyOfCall(fetchMock, 0));
  });

  it("marks a refusal whose body is not JSON unreadable, and keeps its key", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const responses = [
      new Response("<html>", { status: 422, headers: { "content-type": "application/json" } }),
      jsonResponse(201),
    ];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        responses.shift() ?? jsonResponse(201)
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await dashboardFetch(PATH, { method: "POST", body: { amount: "1" } });
    await submit();

    expect(first).toMatchObject({ ok: false, status: 422, unreadable: true });
    expect(keyOfCall(fetchMock, 1)).toBe(keyOfCall(fetchMock, 0));
  });

  it("reports an unknown outcome's code and sends nothing more on its own", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const body = { error: { code: "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN", message: "check" } };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(body, { status: 409 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dashboardFetch(PATH, { method: "POST", body: { amount: "1" } });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      code: "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the key when a success's body fails to download", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const brokenBody = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("connection reset"));
          },
        }),
        { status: 201 }
      );
    const fetchMock = vi
      .fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(201))
      .mockResolvedValueOnce(brokenBody());
    vi.stubGlobal("fetch", fetchMock);

    await expect(submit()).rejects.toThrow();
    await submit();

    expect(keyOfCall(fetchMock, 1)).toBe(keyOfCall(fetchMock, 0));
  });

  it("sends nothing for a call already cancelled", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const fetchMock = statusFetchMock(201);
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(
      dashboardRequest(PATH, { method: "POST", body: "{}", signal: controller.signal })
    ).rejects.toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to send a money movement when storage refuses its key", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    installSessionStorage(true);
    const fetchMock = statusFetchMock(201);
    vi.stubGlobal("fetch", fetchMock);

    const response = await submit();

    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_KEY_NOT_PERSISTED" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The refusal only drops a key it minted: a reused key belongs to an
  // unanswered attempt that may have written, and its retry still needs it.
  it("keeps an unanswered attempt's key through a storage refusal", async () => {
    setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const storage = installSessionStorage();
    const fetchMock = vi
      .fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(201))
      .mockRejectedValueOnce(new TypeError("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submit()).rejects.toThrow("network down");
    storage.refuseWrites = true;
    // The key is already in storage, so the retry is sent under it.
    expect((await submit()).status).toBe(201);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keyOfCall(fetchMock, 1)).toBe(keyOfCall(fetchMock, 0));
  });

  it("still sends any other mutation, reusing the key in this page, when storage refuses it", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/counterparties`);
    installSessionStorage(true);
    const fetchMock = statusFetchMock(502, 201);
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const createCounterparty = () =>
      dashboardRequest("/api/dashboard/counterparty", { method: "POST", body: '{"name":"a"}' });

    await createCounterparty();
    await createCounterparty();

    expect(keyOfCall(fetchMock, 0)).toMatch(/^[0-9a-f-]{36}$/);
    expect(keyOfCall(fetchMock, 1)).toBe(keyOfCall(fetchMock, 0));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not let one caller's abort cancel the request another caller joined", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
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
    respond(jsonResponse(201));

    await expect(aborted).rejects.toBeDefined();
    expect((await joined).status).toBe(201);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeUndefined();
  });

  it("joins a double submit of the same action into one request", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const fetchMock = statusFetchMock(201);
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([submit(), submit()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await first.text()).toBe("{}");
    expect(await second.text()).toBe("{}");
  });

  // Greptile (#2333): after a user switch in the tab, the same submit joined the
  // first user's pending request and got its answer.
  it("never joins a pending request of another signed-in user", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const fetchMock = statusFetchMock(201, 201);
    vi.stubGlobal("fetch", fetchMock);

    setIdempotencyKeyScope("user_a:org_1");
    const first = submit();
    setIdempotencyKeyScope("user_b:org_1");
    const second = submit();
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Greptile (#2252): a live submit must never join a demo request of the same
  // body, or it would receive the demo's canned answer.
  it("keeps demo and live submits of the same body apart", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const fetchMock = statusFetchMock(201, 201);
    vi.stubGlobal("fetch", fetchMock);

    setTabShowsDemo(true);
    const demo = submit();
    setTabShowsDemo(false);
    const live = submit();
    await Promise.all([demo, live]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const demoHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const liveHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(demoHeaders.get(TAB_DEMO_HEADER_NAME)).toBe("1");
    expect(liveHeaders.get(TAB_DEMO_HEADER_NAME)).toBeNull();
    expect(keyOfCall(fetchMock, 0)).not.toBe(keyOfCall(fetchMock, 1));
  });

  it("gives a different action its own key", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const fetchMock = statusFetchMock(502, 502);
    vi.stubGlobal("fetch", fetchMock);

    await submit('{"amount":"1"}');
    await submit('{"amount":"2"}');

    expect(keyOfCall(fetchMock, 0)).not.toBe(keyOfCall(fetchMock, 1));
  });

  it("keys every mutation, whatever module, and leaves a caller-chosen key and reads alone", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments/recurring`);
    const fetchMock = statusFetchMock(201, 200, 201);
    vi.stubGlobal("fetch", fetchMock);

    await dashboardRequest(PATH, {
      method: "POST",
      headers: { "Idempotency-Key": "own-key" },
      body: "{}",
    });
    await dashboardRequest(PATH, { method: "GET" });
    await dashboardRequest("/api/dashboard/counterparty", { method: "POST", body: "{}" });

    expect(keyOfCall(fetchMock, 0)).toBe("own-key");
    expect(keyOfCall(fetchMock, 1)).toBeNull();
    expect(keyOfCall(fetchMock, 2)).toMatch(/^[0-9a-f-]{36}$/);
  });

  // They fire as the user types; keyed, each would leave an unanswered key
  // behind that never expires.
  it("leaves read-like POSTs (estimates, quotes, simulations) unkeyed", async () => {
    openTab(`/dashboard/${SANDBOX_PROJECT.id}/payments`);
    const fetchMock = statusFetchMock(200, 200, 200, 200);
    vi.stubGlobal("fetch", fetchMock);

    for (const path of [
      "/api/dashboard/payments/transfers/batch/estimate",
      "/api/dashboard/payments/ramps/onramp/quote",
      "/api/dashboard/payments/ramps/offramp/estimate?draft=1",
      "/api/dashboard/payments/ramps/sandbox/simulate",
    ]) {
      await dashboardRequest(path, { method: "POST", body: "{}" });
    }

    expect([0, 1, 2, 3].map((index) => keyOfCall(fetchMock, index))).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
});
