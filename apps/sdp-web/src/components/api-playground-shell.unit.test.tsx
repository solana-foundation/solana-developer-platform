// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { clearStoredApiKeySecrets, storeApiKeySecret } from "@/lib/playground-api-keys";
import { type ApiPlaygroundEndpointConfig, ApiPlaygroundShell } from "./api-playground-shell";
import { ThemeScopeProvider } from "./theme-scope-provider";

const mocks = vi.hoisted(() => ({
  replaceSearchParams: vi.fn(),
  searchParamGet: vi.fn(() => null as string | null),
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

describe("ApiPlaygroundShell secret redaction", () => {
  beforeEach(() => {
    clearStoredApiKeySecrets();
    mocks.replaceSearchParams.mockReset();
    mocks.searchParamGet.mockReset();
    mocks.searchParamGet.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
    clearStoredApiKeySecrets();
    vi.unstubAllGlobals();
  });

  it("does not render a submitted secret from a rejected client request", async () => {
    const secret = ["sk", "test", "client", "error", "fixture"].join("_");
    storeApiKeySecret({ value: secret, apiKeyId: "key-test" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(`Rejected Bearer ${secret}`)));
    const view = render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiPlaygroundShell apiKeyId="key-test" endpoints={[endpoint]} productName="Test product" />
      </I18nProvider>
    );

    fireEvent.click(view.getByRole("button", { name: "Run request" }));

    await waitFor(() => expect(view.container.textContent).toContain("Request execution failed."));
    expect(view.container.textContent).not.toContain(secret);
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
          <ApiPlaygroundShell apiKeyId={null} endpoints={[endpoint]} productName="Test product" />
        </ThemeScopeProvider>
      </I18nProvider>
    );

    expect(view.getAllByTestId("api-playground-code")).toHaveLength(1);

    await user.click(view.getByRole("tab", { name: "Code" }));

    const panels = view.getAllByTestId("api-playground-code");
    expect(panels).toHaveLength(2);
    expect(panels[0].textContent).toContain("/v1/test");
  });

  it("offers Create an API key instead of Run when the project has none", () => {
    const view = render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ThemeScopeProvider scope="refresh">
          <ApiPlaygroundShell
            apiKeyId={null}
            endpoints={[endpoint]}
            productName="Test product"
            requiresApiKey
            createApiKeyHref="/dashboard/api-keys/new"
          />
        </ThemeScopeProvider>
      </I18nProvider>
    );
    expect(view.getByRole("link", { name: "Create an API key" }).getAttribute("href")).toBe(
      "/dashboard/api-keys/new"
    );
    expect(view.queryByRole("button", { name: /Run request/ })).toBeNull();
    expect(
      view.queryByText("Create an API key first to enable live playground requests.")
    ).toBeNull();
  });

  it("keeps Run waiting, and says why, for someone who cannot make a key", () => {
    const view = render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ThemeScopeProvider scope="refresh">
          <ApiPlaygroundShell
            apiKeyId={null}
            endpoints={[endpoint]}
            productName="Test product"
            requiresApiKey
          />
        </ThemeScopeProvider>
      </I18nProvider>
    );
    expect((view.getByRole("button", { name: /Run request/ }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(
      view.getByText("Create an API key first to enable live playground requests.")
    ).toBeTruthy();
  });

  it("writes the call in the chosen language and wraps it instead of scrolling", async () => {
    const user = userEvent.setup();
    const view = render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ThemeScopeProvider scope="refresh">
          <ApiPlaygroundShell apiKeyId={null} endpoints={[endpoint]} productName="Test product" />
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
