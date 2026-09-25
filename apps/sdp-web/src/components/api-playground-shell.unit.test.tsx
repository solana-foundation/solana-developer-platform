// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { clearStoredApiKeySecrets, storeApiKeySecret } from "@/lib/playground-api-keys";
import { type ApiPlaygroundEndpointConfig, ApiPlaygroundShell } from "./api-playground-shell";

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

describe("ApiPlaygroundShell response identity isolation", () => {
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

  it("clears a response from a prior API-key identity when the key changes", async () => {
    storeApiKeySecret({ value: "sk_test_project_a", apiKeyId: "key-a" });
    storeApiKeySecret({ value: "sk_test_project_b", apiKeyId: "key-b" });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          status: 200,
          statusText: "OK",
          body: { project: "project-a", balance: "1000 SOL" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const view = render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiPlaygroundShell apiKeyId="key-a" endpoints={[endpoint]} productName="Test product" />
      </I18nProvider>
    );

    fireEvent.click(view.getByRole("button", { name: "Run request" }));
    await waitFor(() => expect(view.container.textContent).toContain('"project": "project-a"'));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Same endpoint, same shell instance: only the project-derived key identity
    // changes. The prior response must not remain rendered, and no request may
    // be issued implicitly.
    view.rerender(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiPlaygroundShell apiKeyId="key-b" endpoints={[endpoint]} productName="Test product" />
      </I18nProvider>
    );

    expect(view.container.textContent).not.toContain('"project": "project-a"');
    expect(view.container.textContent).not.toContain('"balance": "1000 SOL"');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("discards an in-flight response that resolves after the API-key identity changes", async () => {
    storeApiKeySecret({ value: "sk_test_project_a", apiKeyId: "key-a" });
    let resolveResponse: (response: Response) => void = () => {};
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const view = render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiPlaygroundShell apiKeyId="key-a" endpoints={[endpoint]} productName="Test product" />
      </I18nProvider>
    );

    fireEvent.click(view.getByRole("button", { name: "Run request" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    view.rerender(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiPlaygroundShell apiKeyId="key-b" endpoints={[endpoint]} productName="Test product" />
      </I18nProvider>
    );

    await act(async () => {
      resolveResponse(
        new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            statusText: "OK",
            body: { project: "project-a", balance: "1000 SOL" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    });

    expect(view.container.textContent).not.toContain('"project": "project-a"');
    expect(view.container.textContent).not.toContain('"balance": "1000 SOL"');
    expect(view.container.textContent).not.toContain("200 OK");
  });

  it("discards a response that resolves after switching away and back to the same key", async () => {
    storeApiKeySecret({ value: "sk_test_project_a", apiKeyId: "key-a" });
    storeApiKeySecret({ value: "sk_test_project_b", apiKeyId: "key-b" });
    const deferred: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          deferred.push(resolve);
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const view = render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiPlaygroundShell apiKeyId="key-a" endpoints={[endpoint]} productName="Test product" />
      </I18nProvider>
    );

    fireEvent.click(view.getByRole("button", { name: "Run request" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Round trip through another identity before the first response resolves:
    // the epoch guard must discard it even though the visible identity is
    // back to key-a.
    view.rerender(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiPlaygroundShell apiKeyId="key-b" endpoints={[endpoint]} productName="Test product" />
      </I18nProvider>
    );
    view.rerender(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiPlaygroundShell apiKeyId="key-a" endpoints={[endpoint]} productName="Test product" />
      </I18nProvider>
    );

    await act(async () => {
      deferred[0]?.(
        new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            statusText: "OK",
            body: { project: "project-a", balance: "1000 SOL" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    });

    expect(view.container.textContent).not.toContain('"project": "project-a"');
    expect(view.container.textContent).not.toContain('"balance": "1000 SOL"');
    expect(view.container.textContent).not.toContain("200 OK");

    // A request issued under the restored identity still works and renders.
    fireEvent.click(view.getByRole("button", { name: "Run request" }));
    await act(async () => {
      deferred[1]?.(
        new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            statusText: "OK",
            body: { project: "project-a", balance: "42 SOL" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    });

    expect(view.container.textContent).toContain('"balance": "42 SOL"');
    expect(view.container.textContent).toContain("200 OK");
    expect(view.container.textContent).not.toContain('"balance": "1000 SOL"');
  });

  it("keeps a rendered response hidden when switching away and back to the key it was produced under", async () => {
    storeApiKeySecret({ value: "sk_test_project_a", apiKeyId: "key-a" });
    storeApiKeySecret({ value: "sk_test_project_b", apiKeyId: "key-b" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            statusText: "OK",
            body: { project: "project-a", balance: "1000 SOL" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            statusText: "OK",
            body: { project: "project-a", balance: "42 SOL" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const view = render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiPlaygroundShell apiKeyId="key-a" endpoints={[endpoint]} productName="Test product" />
      </I18nProvider>
    );

    // The response lands and renders while the identity still matches.
    fireEvent.click(view.getByRole("button", { name: "Run request" }));
    await waitFor(() => expect(view.container.textContent).toContain('"balance": "1000 SOL"'));

    // Leaving the identity hides the rendered response…
    view.rerender(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiPlaygroundShell apiKeyId="key-b" endpoints={[endpoint]} productName="Test product" />
      </I18nProvider>
    );
    expect(view.container.textContent).not.toContain('"balance": "1000 SOL"');

    // …and returning to the identity it was produced under must not resurface
    // it: the epoch gate keeps it hidden even though the key IDs match again.
    view.rerender(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiPlaygroundShell apiKeyId="key-a" endpoints={[endpoint]} productName="Test product" />
      </I18nProvider>
    );
    expect(view.container.textContent).not.toContain('"balance": "1000 SOL"');

    // A request issued under the restored identity still works and renders.
    fireEvent.click(view.getByRole("button", { name: "Run request" }));
    await waitFor(() => expect(view.container.textContent).toContain('"balance": "42 SOL"'));
    expect(view.container.textContent).not.toContain('"balance": "1000 SOL"');
  });

  it("executes subsequent requests with the new key identity after a change", async () => {
    storeApiKeySecret({ value: "sk_test_project_a", apiKeyId: "key-a" });
    storeApiKeySecret({ value: "sk_test_project_b", apiKeyId: "key-b" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            statusText: "OK",
            body: { project: "project-a", balance: "1000 SOL" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            statusText: "OK",
            body: { project: "project-b", balance: "42 SOL" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const view = render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiPlaygroundShell apiKeyId="key-a" endpoints={[endpoint]} productName="Test product" />
      </I18nProvider>
    );

    fireEvent.click(view.getByRole("button", { name: "Run request" }));
    await waitFor(() => expect(view.container.textContent).toContain('"project": "project-a"'));

    view.rerender(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <ApiPlaygroundShell apiKeyId="key-b" endpoints={[endpoint]} productName="Test product" />
      </I18nProvider>
    );

    fireEvent.click(view.getByRole("button", { name: "Run request" }));
    await waitFor(() => expect(view.container.textContent).toContain('"project": "project-b"'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondRequest = JSON.parse((fetchMock.mock.calls[1]?.[1]?.body as string) ?? "{}") as {
      apiKey?: string;
    };
    expect(secondRequest.apiKey).toBe("sk_test_project_b");
    expect(view.container.textContent).not.toContain('"project": "project-a"');
  });
});
