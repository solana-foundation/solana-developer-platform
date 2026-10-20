// @vitest-environment jsdom

import type { SdpReleaseChannel } from "@sdp/types/release-channels";
import { ThemeScopeProvider } from "@sdp/ui/theme-scope-provider";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import {
  createIdempotencyKeyStore,
  resetIdempotencyKeyStoresForTests,
} from "@/lib/idempotency-key-store";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";
import { type ApiPlaygroundEndpointConfig, ApiPlaygroundShell } from "./api-playground-shell";

interface ShellTestMocks {
  replaceSearchParams: ReturnType<typeof vi.fn>;
  searchParamGet: ReturnType<typeof vi.fn<() => string | null>>;
  /** The dashboard workspace the shell reads its release channel from; none by default. */
  workspace: { flags: { releaseChannel: SdpReleaseChannel } } | undefined;
}

const mocks = vi.hoisted(
  (): ShellTestMocks => ({
    replaceSearchParams: vi.fn(),
    searchParamGet: vi.fn<() => string | null>(() => null),
    workspace: undefined,
  })
);

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useOptionalDashboardWorkspace: () => mocks.workspace,
}));

vi.mock("@/lib/dashboard-url-state", () => ({
  useDashboardUrlState: () => ({
    replaceSearchParams: mocks.replaceSearchParams,
    searchParams: { get: mocks.searchParamGet },
  }),
}));

vi.mock("@/lib/shiki-code", () => ({
  HighlightedCode: ({ content }: { content: string }) => <pre>{content}</pre>,
}));

const endpoint: ApiPlaygroundEndpointConfig = {
  id: "test-request",
  title: "Test request",
  method: "GET",
  path: "/v1/test",
  pathFields: [],
  bodyFields: [],
  expectedResponse: {},
};

describe("ApiPlaygroundShell", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    resetIdempotencyKeyStoresForTests();
    mocks.replaceSearchParams.mockReset();
    mocks.searchParamGet.mockReset();
    mocks.searchParamGet.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
    mocks.workspace = undefined;
    restoreWindowLocation();
    vi.unstubAllGlobals();
  });

  it("runs as the dashboard session for the tab's Project, and never renders a failure's text", async () => {
    const secret = ["sk", "test", "client", "error", "fixture"].join("_");
    setWindowPathname(`/dashboard/${PRODUCTION_PROJECT.id}/api-keys`);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init: RequestInit) => {
      throw new Error(`Rejected Bearer ${secret}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiPlaygroundShell endpoints={[endpoint]} productName="Test product" />
      </I18nProvider>
    );

    fireEvent.click(view.getByRole("button", { name: "Run request" }));

    await waitFor(() => expect(view.container.textContent).toContain("Request execution failed."));
    expect(view.container.textContent).not.toContain(secret);
    const [proxyPath, proxyInit] = fetchMock.mock.calls[0];
    expect(proxyPath).toBe("/api/playground/execute");
    const headers = new Headers(proxyInit.headers);
    expect(headers.get("x-project-id")).toBe(PRODUCTION_PROJECT.id);
    // No key and no bearer leave the browser: the execute route runs on the session.
    expect(headers.has("Authorization")).toBe(false);
    expect(JSON.parse(String(proxyInit.body))).toEqual({
      method: "GET",
      path: "/v1/test",
      body: null,
    });
  });

  // Greptile (#2433): the previous build kept a lost write's key under a digest
  // that named the pasted key, so no Send here retries it; it must not go out
  // again unchecked under a new key.
  it("holds writes after an update left an earlier write unanswered, until the user confirms", async () => {
    setWindowPathname(`/dashboard/${PRODUCTION_PROJECT.id}/api-keys`);
    createIdempotencyKeyStore("sdp:playground:retry:idempotency:v1").claim("unsettled-send", () =>
      JSON.stringify({ request: "digest-from-the-key-build", key: "key-from-the-key-build" })
    );
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init: RequestInit) =>
        new Response(
          JSON.stringify({ ok: true, status: 201, statusText: "Created", body: {}, headers: {} }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    const view = render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiPlaygroundShell
          endpoints={[{ ...endpoint, id: "post-after-update", method: "POST" }]}
          productName="Test product"
        />
      </I18nProvider>
    );

    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const run = () => fireEvent.click(view.getByRole("button", { name: "Run request" }));

    // Declined, twice: nothing goes out and the earlier write stays held.
    run();
    await waitFor(() => expect(view.container.textContent).toContain("Not sent."));
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Run request" }).hasAttribute("disabled")).toBe(false)
    );
    run();
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(fetchMock).not.toHaveBeenCalled();

    // Confirmed: this write goes out, and the next one is not asked about again.
    confirm.mockReturnValue(true);
    run();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Run request" }).hasAttribute("disabled")).toBe(false)
    );
    run();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it("sends a new Idempotency-Key with each Send of a POST, and none with a GET", async () => {
    setWindowPathname(`/dashboard/${PRODUCTION_PROJECT.id}/api-keys`);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init: RequestInit) =>
        new Response(
          JSON.stringify({ ok: true, status: 201, statusText: "Created", body: {}, headers: {} }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    const postEndpoint: ApiPlaygroundEndpointConfig = {
      ...endpoint,
      id: "post-request",
      method: "POST",
    };
    const view = render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiPlaygroundShell endpoints={[postEndpoint]} productName="Test product" />
      </I18nProvider>
    );
    const sentKey = (call: number) =>
      z
        .object({ idempotencyKey: z.string().optional() })
        .parse(JSON.parse(String(fetchMock.mock.calls[call][1].body))).idempotencyKey;

    fireEvent.click(view.getByRole("button", { name: "Run request" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Run request" }).hasAttribute("disabled")).toBe(false)
    );
    fireEvent.click(view.getByRole("button", { name: "Run request" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const first = sentKey(0);
    const second = sentKey(1);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);

    cleanup();
    fetchMock.mockClear();
    const getView = render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiPlaygroundShell endpoints={[endpoint]} productName="Test product" />
      </I18nProvider>
    );
    fireEvent.click(getView.getByRole("button", { name: "Run request" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentKey(0)).toBeUndefined();
  });

  // Jina (#2333): a Send after a lost answer used a new key, so the API ran the
  // write again instead of replaying the first attempt.
  it("resends a lost or 5xx-answered POST under its key, and a settled one under a new key", async () => {
    setWindowPathname(`/dashboard/${PRODUCTION_PROJECT.id}/api-keys`);
    const envelope = (status: number) =>
      new Response(
        JSON.stringify({ ok: status < 400, status, statusText: "", body: {}, headers: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    const answers: (Response | "lost")[] = ["lost", envelope(503), envelope(201)];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init: RequestInit) => {
      const answer = answers.shift() ?? envelope(201);
      if (answer === "lost") throw new TypeError("Failed to fetch");
      return answer;
    });
    vi.stubGlobal("fetch", fetchMock);
    const postEndpoint: ApiPlaygroundEndpointConfig = {
      ...endpoint,
      id: "post-retry",
      method: "POST",
    };
    const view = render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiPlaygroundShell endpoints={[postEndpoint]} productName="Test product" />
      </I18nProvider>
    );
    const sentKey = (call: number) =>
      z
        .object({ idempotencyKey: z.string().optional() })
        .parse(JSON.parse(String(fetchMock.mock.calls[call][1].body))).idempotencyKey;
    const send = async (calls: number) => {
      await waitFor(() =>
        expect(view.getByRole("button", { name: "Run request" }).hasAttribute("disabled")).toBe(
          false
        )
      );
      fireEvent.click(view.getByRole("button", { name: "Run request" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(calls));
    };

    await send(1);
    await send(2);
    await send(3);
    await send(4);

    expect(sentKey(1)).toBe(sentKey(0));
    expect(sentKey(2)).toBe(sentKey(0));
    expect(sentKey(3)).not.toBe(sentKey(2));
  });

  // Jina (#2333): a money route went out under a key the browser would not
  // keep, so a reload and retry could send the payment again under a new key.
  it("does not send a transfer when the browser will not keep its retry key", async () => {
    setWindowPathname(`/dashboard/${PRODUCTION_PROJECT.id}/api-keys`);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init: RequestInit) => new Response("{}")
    );
    vi.stubGlobal("fetch", fetchMock);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    try {
      const transferEndpoint: ApiPlaygroundEndpointConfig = {
        ...endpoint,
        id: "post-transfer",
        method: "POST",
        path: "/v1/payments/transfers",
      };
      const view = render(
        <I18nProvider locale="en" messages={getMessages("en")}>
          <ApiPlaygroundShell endpoints={[transferEndpoint]} productName="Test product" />
        </I18nProvider>
      );
      await waitFor(() =>
        expect(view.getByRole("button", { name: "Run request" }).hasAttribute("disabled")).toBe(
          false
        )
      );
      fireEvent.click(view.getByRole("button", { name: "Run request" }));

      expect(await view.findByText(/isn’t keeping the request’s retry key/)).toBeTruthy();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });

  // Jina (#2333): the unsettled key lived only in module memory, so a reload
  // between a lost write and its retry sent the retry under a new key.
  it("keeps a lost POST's key across a reload, in session storage, so the retry still reuses it", async () => {
    setWindowPathname(`/dashboard/${PRODUCTION_PROJECT.id}/api-keys`);
    const envelope = (status: number) =>
      new Response(
        JSON.stringify({ ok: status < 400, status, statusText: "", body: {}, headers: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    const answers: (Response | "lost")[] = ["lost", envelope(201)];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init: RequestInit) => {
      const answer = answers.shift() ?? envelope(201);
      if (answer === "lost") throw new TypeError("Failed to fetch");
      return answer;
    });
    vi.stubGlobal("fetch", fetchMock);
    const postEndpoint: ApiPlaygroundEndpointConfig = {
      ...endpoint,
      id: "post-reload",
      method: "POST",
    };
    const sendWith = async (
      Shell: typeof ApiPlaygroundShell,
      Provider: typeof I18nProvider,
      messages: ReturnType<typeof getMessages>,
      calls: number
    ) => {
      const view = render(
        <Provider locale="en" messages={messages}>
          <Shell endpoints={[postEndpoint]} productName="Test product" />
        </Provider>
      );
      await waitFor(() =>
        expect(view.getByRole("button", { name: "Run request" }).hasAttribute("disabled")).toBe(
          false
        )
      );
      fireEvent.click(view.getByRole("button", { name: "Run request" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(calls));
      cleanup();
    };
    const sentKey = (call: number) =>
      z
        .object({ idempotencyKey: z.string().optional() })
        .parse(JSON.parse(String(fetchMock.mock.calls[call][1].body))).idempotencyKey;

    await sendWith(ApiPlaygroundShell, I18nProvider, getMessages("en"), 1);
    // The reload: every module starts over; only session storage survives.
    vi.resetModules();
    const reloaded = await import("./api-playground-shell");
    const reloadedI18n = await import("@/i18n/provider");
    const reloadedMessages = await import("@/i18n/messages");
    await sendWith(
      reloaded.ApiPlaygroundShell,
      reloadedI18n.I18nProvider,
      reloadedMessages.getMessages("en"),
      2
    );

    expect(sentKey(0)).toEqual(expect.any(String));
    expect(sentKey(1)).toBe(sentKey(0));
  });

  // Greptile (#2333): a GET between a lost write and its retry cleared the
  // write's key, so the retry ran the write again under a new one.
  it("keeps a lost POST's key across a GET, so the retry still reuses it", async () => {
    setWindowPathname(`/dashboard/${PRODUCTION_PROJECT.id}/api-keys`);
    const envelope = (status: number) =>
      new Response(
        JSON.stringify({ ok: status < 400, status, statusText: "", body: {}, headers: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    const answers: (Response | "lost")[] = ["lost", envelope(200), envelope(201)];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init: RequestInit) => {
      const answer = answers.shift() ?? envelope(201);
      if (answer === "lost") throw new TypeError("Failed to fetch");
      return answer;
    });
    vi.stubGlobal("fetch", fetchMock);
    const postEndpoint: ApiPlaygroundEndpointConfig = {
      ...endpoint,
      id: "post-retry",
      method: "POST",
    };
    const getEndpoint: ApiPlaygroundEndpointConfig = {
      ...endpoint,
      id: "get-check",
      method: "GET",
    };
    const sendOn = async (config: ApiPlaygroundEndpointConfig, calls: number) => {
      const view = render(
        <I18nProvider locale="en" messages={getMessages("en")}>
          <ApiPlaygroundShell endpoints={[config]} productName="Test product" />
        </I18nProvider>
      );
      await waitFor(() =>
        expect(view.getByRole("button", { name: "Run request" }).hasAttribute("disabled")).toBe(
          false
        )
      );
      fireEvent.click(view.getByRole("button", { name: "Run request" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(calls));
      cleanup();
    };
    const sentKey = (call: number) =>
      z
        .object({ idempotencyKey: z.string().optional() })
        .parse(JSON.parse(String(fetchMock.mock.calls[call][1].body))).idempotencyKey;

    await sendOn(postEndpoint, 1);
    await sendOn(getEndpoint, 2);
    await sendOn(postEndpoint, 3);

    expect(sentKey(0)).toEqual(expect.any(String));
    expect(sentKey(1)).toBeUndefined();
    expect(sentKey(2)).toBe(sentKey(0));
  });
});

describe("ApiPlaygroundShell refresh layout", () => {
  afterEach(() => {
    cleanup();
  });

  // playwright/tests/theme.e2e.spec.ts reads the code tokens off this panel.
  it("shows the fetch snippet in the first code panel once the Code view is open", async () => {
    const user = userEvent.setup();
    const view = render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ThemeScopeProvider scope="refresh">
          <ApiPlaygroundShell endpoints={[endpoint]} productName="Test product" />
        </ThemeScopeProvider>
      </I18nProvider>
    );

    expect(view.getAllByTestId("api-playground-code")).toHaveLength(1);

    await user.click(view.getByRole("tab", { name: "Code" }));

    const panels = view.getAllByTestId("api-playground-code");
    expect(panels).toHaveLength(2);
    expect(panels[0].textContent).toContain("/v1/test");
  });

  it("says the playground has nothing to run when no offered operation is published", () => {
    mocks.workspace = { flags: { releaseChannel: "experimental" } };
    try {
      const view = render(
        <I18nProvider locale="en" messages={getMessages("en")}>
          <ApiPlaygroundShell endpoints={[endpoint]} productName="Test product" />
        </I18nProvider>
      );
      expect(
        view.getByText(
          "None of these operations are in the public API reference yet, so the playground has nothing to run here."
        )
      ).toBeTruthy();
    } finally {
      mocks.workspace = undefined;
    }
  });

  it("offers Run with no API key at all", () => {
    const view = render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ThemeScopeProvider scope="refresh">
          <ApiPlaygroundShell endpoints={[endpoint]} productName="Test product" />
        </ThemeScopeProvider>
      </I18nProvider>
    );
    expect((view.getByRole("button", { name: /Run request/ }) as HTMLButtonElement).disabled).toBe(
      false
    );
    expect(view.queryByRole("link", { name: "Create an API key" })).toBeNull();
  });

  it("writes the call in the chosen language and wraps it instead of scrolling", async () => {
    const user = userEvent.setup();
    const view = render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ThemeScopeProvider scope="refresh">
          <ApiPlaygroundShell endpoints={[endpoint]} productName="Test product" />
        </ThemeScopeProvider>
      </I18nProvider>
    );
    await user.click(view.getByRole("tab", { name: "Code" }));
    const snippet = () => view.getAllByTestId("api-playground-code")[0];
    expect(snippet().textContent).toContain("curl");
    expect(snippet().querySelector("pre")?.className).toContain("whitespace-pre-wrap");

    fireEvent.change(view.getByLabelText("Language"), { target: { value: "py" } });
    expect(snippet().textContent).toContain("requests.get(");
    expect(view.getByRole("button", { name: "Copy prompt for an assistant" })).toBeTruthy();
  });
});
