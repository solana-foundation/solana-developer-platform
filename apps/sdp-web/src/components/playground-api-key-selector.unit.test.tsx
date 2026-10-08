// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import {
  clearStoredApiKeySecrets,
  getStoredApiKeySecret,
  PLAYGROUND_API_KEY_INACTIVITY_TIMEOUT_MS,
} from "@/lib/playground-api-keys";
import { usePlaygroundApiKeySecret } from "@/lib/use-playground-api-key-secret";
import { resetDashboardNavigation, setDashboardUrl } from "@/test/dashboard-navigation";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";
import { type ApiPlaygroundEndpointConfig, ApiPlaygroundShell } from "./api-playground-shell";
import { PlaygroundApiKeySelector } from "./playground-api-key-selector";
import { ThemeScopeProvider } from "./theme-scope-provider";

const workspace = vi.hoisted(() => ({
  dashboardAccess: { capabilities: { canManageApiKeys: true } },
  playgroundApiKeys: [
    {
      id: "key_test",
      name: "Test key",
      keyPrefix: "sk_test_example",
      role: "api_developer",
      environment: "sandbox",
    },
    {
      id: "key_other_workspace",
      name: "Other workspace key",
      keyPrefix: "sk_test_example",
      role: "api_developer",
      environment: "sandbox",
    },
  ],
  sdpEnvironment: "sandbox" as const,
  selectedPlaygroundApiKeyId: null as string | null,
  setSelectedPlaygroundApiKeyId: vi.fn((id: string | null) => {
    workspace.selectedPlaygroundApiKeyId = id;
  }),
}));

const PLAYGROUND_API_KEYS = workspace.playgroundApiKeys;

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => workspace,
}));

vi.mock("@/lib/dashboard-url-state", () => ({
  useDashboardUrlState: () => ({ replaceSearchParams: vi.fn(), searchParams: { get: () => null } }),
}));

vi.mock("@/lib/shiki-code", () => ({
  HighlightedCode: ({ content }: { content: string }) => <pre>{content}</pre>,
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));

/**
 * Stands in for the resolve route. The component must take the key id from what
 * the server returns, never from anything it can see in the pasted value, so the
 * fixture deliberately returns an id that the key material does not spell.
 */
function mockResolve(result: { ok: boolean; body: unknown }) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init: RequestInit) => ({
    ok: result.ok,
    json: async () => result.body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function SelectedSecretProbe() {
  const value = usePlaygroundApiKeySecret({
    apiKeyId: workspace.selectedPlaygroundApiKeyId,
  });
  return <output data-testid="selected-secret">{value}</output>;
}

function ui() {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <PlaygroundApiKeySelector />
      <SelectedSecretProbe />
    </I18nProvider>
  );
}

describe("PlaygroundApiKeySelector", () => {
  beforeEach(() => {
    resetDashboardNavigation();
    setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}`);
    clearStoredApiKeySecrets();
    workspace.playgroundApiKeys = PLAYGROUND_API_KEYS;
    workspace.selectedPlaygroundApiKeyId = null;
  });

  afterEach(() => {
    cleanup();
    restoreWindowLocation();
    clearStoredApiKeySecrets();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("is a single control: there is no key picker to choose from", () => {
    const view = render(ui());

    expect(view.queryByRole("combobox")).toBeNull();
    expect(view.queryByLabelText("Select API key")).toBeNull();

    const secretInput = view.getByLabelText("API key value") as HTMLInputElement;
    expect(secretInput.type).toBe("password");
    expect(secretInput.autocomplete).toBe("new-password");
  });

  it("attaches a pasted secret to the key the server identifies and publishes it", async () => {
    const fetchMock = mockResolve({
      ok: true,
      body: {
        id: "key_other_workspace",
        name: "Other workspace key",
        keyPrefix: "sk_test_example",
      },
    });
    const view = render(ui());
    const secretInput = view.getByLabelText("API key value") as HTMLInputElement;

    fireEvent.change(secretInput, { target: { value: "Bearer sk_test_session_secret" } });

    expect(secretInput.value).toBe("sk_test_session_secret");

    fireEvent.blur(secretInput);

    await waitFor(() => {
      expect(workspace.setSelectedPlaygroundApiKeyId).toHaveBeenCalledWith("key_other_workspace");
    });

    view.rerender(ui());
    expect(view.getByTestId("selected-secret").textContent).toBe("sk_test_session_secret");
    expect(getStoredApiKeySecret({ apiKeyId: "key_other_workspace" })).toBe(
      "sk_test_session_secret"
    );
    expect(getStoredApiKeySecret({ apiKeyId: "key_test" })).toBeNull();
    const [resolvePath, resolveInit] = fetchMock.mock.calls[0];
    expect(resolvePath).toBe("/api/playground/api-key");
    expect(JSON.parse(String(resolveInit.body))).toEqual({ apiKey: "sk_test_session_secret" });
    expect(new Headers(resolveInit.headers).get("x-project-id")).toBe(SANDBOX_PROJECT.id);
  });

  it("links key creation inside the URL's Project when the Project has no keys", () => {
    setDashboardUrl(`/dashboard/${PRODUCTION_PROJECT.id}`, {});
    workspace.playgroundApiKeys = [];
    const view = render(ui());

    expect(view.getByRole("link", { name: "Create API key" }).getAttribute("href")).toBe(
      `/dashboard/${PRODUCTION_PROJECT.id}/api-keys`
    );
  });

  it("keeps a rejected key out of the store and off the playground", async () => {
    mockResolve({
      ok: false,
      body: { error: "API key is not available for the selected project" },
    });
    const view = render(ui());
    const secretInput = view.getByLabelText("API key value") as HTMLInputElement;

    fireEvent.change(secretInput, { target: { value: "sk_test_not_mine" } });
    fireEvent.blur(secretInput);

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toBe(
        "API key is not available for the selected project"
      );
    });
    expect(workspace.selectedPlaygroundApiKeyId).toBeNull();
    expect(getStoredApiKeySecret({ apiKeyId: "key_test" })).toBeNull();
  });

  it("rejects material that is not shaped like a key without calling the server", async () => {
    const fetchMock = mockResolve({ ok: true, body: {} });
    const view = render(ui());
    const secretInput = view.getByLabelText("API key value") as HTMLInputElement;

    fireEvent.change(secretInput, { target: { value: "not-a-key" } });
    fireEvent.blur(secretInput);

    await waitFor(() => {
      expect(view.getByRole("alert")).toBeTruthy();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("detaches the attached key as soon as the field is edited again", async () => {
    mockResolve({
      ok: true,
      body: { id: "key_test", name: "Test key", keyPrefix: "sk_test_example" },
    });
    const view = render(ui());
    const secretInput = view.getByLabelText("API key value") as HTMLInputElement;

    fireEvent.change(secretInput, { target: { value: "sk_test_session_secret" } });
    fireEvent.blur(secretInput);
    await waitFor(() =>
      expect(getStoredApiKeySecret({ apiKeyId: "key_test" })).toBe("sk_test_session_secret")
    );

    fireEvent.change(secretInput, { target: { value: "sk_test_session_secre" } });

    expect(getStoredApiKeySecret({ apiKeyId: "key_test" })).toBeNull();
    expect(workspace.selectedPlaygroundApiKeyId).toBeNull();
  });

  it("ignores an answer for key material the user has already replaced", async () => {
    let releaseFirst: (() => void) | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body)) as { apiKey: string };
      if (sent.apiKey === "sk_test_first_key") {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return {
        ok: true,
        json: async () => ({
          id: sent.apiKey === "sk_test_first_key" ? "key_test" : "key_other_workspace",
          name: "Resolved key",
          keyPrefix: "sk_test_example",
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(ui());
    const secretInput = view.getByLabelText("API key value") as HTMLInputElement;

    fireEvent.change(secretInput, { target: { value: "sk_test_first_key" } });
    fireEvent.blur(secretInput);

    fireEvent.change(secretInput, { target: { value: "sk_test_second_key" } });
    releaseFirst?.();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(getStoredApiKeySecret({ apiKeyId: "key_test" })).toBeNull();
    expect(workspace.selectedPlaygroundApiKeyId).toBeNull();
    expect(secretInput.value).toBe("sk_test_second_key");
  });

  it("surfaces an error instead of checking forever when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    const view = render(ui());
    const secretInput = view.getByLabelText("API key value") as HTMLInputElement;

    fireEvent.change(secretInput, { target: { value: "sk_test_unreachable" } });
    fireEvent.blur(secretInput);

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toBe(
        "That key is not available for this project"
      );
    });
    expect(view.queryByText("Checking key")).toBeNull();
    expect(workspace.selectedPlaygroundApiKeyId).toBeNull();
  });

  it("does not extend secret expiry during passive rerenders", async () => {
    mockResolve({
      ok: true,
      body: { id: "key_test", name: "Test key", keyPrefix: "sk_test_example" },
    });
    const view = render(ui());
    const secretInput = view.getByLabelText("API key value") as HTMLInputElement;

    fireEvent.change(secretInput, { target: { value: "sk_test_session_secret" } });
    fireEvent.blur(secretInput);
    await waitFor(() =>
      expect(getStoredApiKeySecret({ apiKeyId: "key_test" })).toBe("sk_test_session_secret")
    );

    const afterStore = Date.now();
    const margin = 5_000;
    vi.useFakeTimers();
    vi.setSystemTime(afterStore + PLAYGROUND_API_KEY_INACTIVITY_TIMEOUT_MS - margin);
    view.rerender(ui());
    expect(secretInput.value).toBe("sk_test_session_secret");

    vi.setSystemTime(afterStore + PLAYGROUND_API_KEY_INACTIVITY_TIMEOUT_MS + margin);
    view.rerender(ui());

    expect(secretInput.value).toBe("");
    expect(getStoredApiKeySecret({ apiKeyId: "key_test" })).toBeNull();
  });
});

describe("PlaygroundApiKeySelector in the refresh playground", () => {
  const endpoint: ApiPlaygroundEndpointConfig = {
    id: "test-request",
    title: "Test request",
    method: "GET",
    path: "/v1/test",
    pathFields: [],
    bodyFields: [],
    expectedResponse: {},
  };

  /** The resolve route names the key; the execute route answers the run. */
  function mockPlaygroundRoutes(resolved: { ok: boolean; body: unknown }) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input) === "/api/playground/api-key"
        ? { ok: resolved.ok, json: async () => resolved.body }
        : {
            ok: true,
            json: async () => ({ ok: true, status: 200, statusText: "OK", body: {}, headers: {} }),
          }
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function sentTo(fetchMock: ReturnType<typeof mockPlaygroundRoutes>, url: string) {
    return fetchMock.mock.calls
      .filter(([input]) => String(input) === url)
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
  }

  /** The playground as a page renders it: the shell's key prop lags the field by a render. */
  function playground() {
    return render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ThemeScopeProvider scope="refresh">
          <ApiPlaygroundShell
            apiKeyId={workspace.selectedPlaygroundApiKeyId}
            apiKeySelector={<PlaygroundApiKeySelector />}
            endpoints={[endpoint]}
            productName="Test product"
          />
        </ThemeScopeProvider>
      </I18nProvider>
    );
  }

  beforeEach(() => {
    clearStoredApiKeySecrets();
    workspace.selectedPlaygroundApiKeyId = null;
  });

  afterEach(() => {
    cleanup();
    clearStoredApiKeySecrets();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("identifies a key pasted with the popover open before ⌘↵ runs the request", async () => {
    // Greptile: the paste detached the previous key, and the popover identifies the new one
    // only as it closes, so the shortcut ran with no key at all.
    const fetchMock = mockPlaygroundRoutes({
      ok: true,
      body: { id: "key_test", name: "Test key", keyPrefix: "sk_test_example" },
    });
    const view = playground();

    fireEvent.click(view.getByRole("button", { name: "Paste a key" }));
    const secretInput = view.getByLabelText("API key value");
    fireEvent.change(secretInput, { target: { value: "sk_test_session_secret" } });
    fireEvent.keyDown(secretInput, { key: "Enter", metaKey: true });

    await waitFor(() =>
      expect(sentTo(fetchMock, "/api/playground/execute")).toEqual([
        expect.objectContaining({ apiKey: "sk_test_session_secret", path: "/v1/test" }),
      ])
    );
    // Identified once, before the run: the popover's close and the run share the answer.
    expect(sentTo(fetchMock, "/api/playground/api-key")).toEqual([
      { apiKey: "sk_test_session_secret" },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/playground/api-key");
    expect(getStoredApiKeySecret({ apiKeyId: "key_test" })).toBe("sk_test_session_secret");
  });

  it("runs once when Run is pressed again while the pasted key is identified", async () => {
    // Greptile P1: every press waited on the same key check, then each one sent the request.
    let releaseResolve: (() => void) | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === "/api/playground/api-key") {
        await new Promise<void>((resolve) => {
          releaseResolve = resolve;
        });
        return {
          ok: true,
          json: async () => ({ id: "key_test", name: "Test key", keyPrefix: "sk_test_example" }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, status: 200, statusText: "OK", body: {}, headers: {} }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = playground();

    fireEvent.click(view.getByRole("button", { name: "Paste a key" }));
    const secretInput = view.getByLabelText("API key value");
    fireEvent.change(secretInput, { target: { value: "sk_test_session_secret" } });
    fireEvent.keyDown(secretInput, { key: "Enter", metaKey: true });
    await waitFor(() => expect(releaseResolve).toBeDefined());

    // Both arrive while the key check is still out.
    fireEvent.keyDown(document.body, { key: "Enter", metaKey: true });
    fireEvent.click(view.getByRole("button", { name: /Run request/ }));
    releaseResolve?.();

    await waitFor(() => expect(sentTo(fetchMock, "/api/playground/execute")).toHaveLength(1));
    await waitFor(() =>
      expect(view.getByRole("button", { name: /Run request/ }).hasAttribute("disabled")).toBe(false)
    );
    expect(sentTo(fetchMock, "/api/playground/execute")).toHaveLength(1);
    expect(sentTo(fetchMock, "/api/playground/api-key")).toHaveLength(1);
  });

  it("does not run with a key the server refuses", async () => {
    const fetchMock = mockPlaygroundRoutes({
      ok: false,
      body: { error: "API key is not available for the selected project" },
    });
    const view = playground();

    fireEvent.click(view.getByRole("button", { name: "Paste a key" }));
    const secretInput = view.getByLabelText("API key value");
    fireEvent.change(secretInput, { target: { value: "sk_test_not_mine" } });
    fireEvent.keyDown(secretInput, { key: "Enter", ctrlKey: true });

    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toBe(
        "API key is not available for the selected project"
      )
    );
    expect(sentTo(fetchMock, "/api/playground/execute")).toEqual([]);
  });
});
