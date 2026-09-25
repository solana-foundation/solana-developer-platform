// @vitest-environment jsdom

/**
 * Recovery from a render-scope refusal must never re-aim a filled-in form at
 * another project (APE-706 / SOLA9-424): a stale scope re-renders the same
 * project with the open form intact, while a project mismatch discards the
 * form before the re-render mints a fresh scope for the new selection —
 * otherwise a manual retry would silently attribute the request to the
 * project the shared cookie moved to.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { PaymentRequestsWorkspace } from "./payment-requests-workspace";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  dashboardFetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("@/lib/dashboard-url-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard-url-state")>()),
  useDashboardTab: () => "overview",
}));

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    sdpEnvironment: "sandbox",
    selectedPlaygroundApiKeyId: null,
    setPlaygroundApiKeys: vi.fn(),
  }),
}));

vi.mock("@/lib/dashboard-fetch", () => ({
  dashboardFetch: mocks.dashboardFetch,
}));

function scopeRejection(code: string) {
  const message = "Project selection changed. Reload the page and try again.";
  return {
    ok: false as const,
    status: 409,
    error: message,
    body: { error: { code, message } },
  };
}

function renderWorkspace() {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <I18nProvider locale="en" messages={getMessages("en")}>
        <PaymentRequestsWorkspace
          initialPaymentRequests={[]}
          apiBaseUrl={null}
          apiKeys={[]}
          wallets={[
            {
              id: "cwl_1",
              walletId: "wal_1",
              publicKey: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
              label: "Primary wallet",
              isRuntimeExecutionAllowed: true,
            },
          ]}
          counterparties={[]}
          renderScope="sealed-scope-a"
        />
      </I18nProvider>
    </SWRConfig>
  );
}

/** Opens the create form, fills every field, and submits it once. */
async function submitCreateForm(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Create" }));

  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });

  const [tokenSelect, walletSelect] = screen.getAllByRole("combobox");
  await user.click(tokenSelect as HTMLElement);
  await user.click((await screen.findAllByRole("option"))[0] as HTMLElement);
  await user.click(walletSelect as HTMLElement);
  await user.click(await screen.findByRole("option", { name: "Primary wallet" }));

  await user.click(screen.getByRole("button", { name: "Create link" }));
}

beforeEach(() => {
  mocks.refresh.mockReset();
  mocks.dashboardFetch.mockReset();
});

afterEach(cleanup);

describe("PaymentRequestsWorkspace render-scope refusal recovery", () => {
  it("sends the page's render scope with the create call", async () => {
    mocks.dashboardFetch.mockResolvedValue(scopeRejection("render_scope_project_mismatch"));
    renderWorkspace();

    await submitCreateForm();

    expect(mocks.dashboardFetch).toHaveBeenCalledTimes(1);
    const [, options] = mocks.dashboardFetch.mock.calls[0] as [string, { headers: unknown }];
    expect((options.headers as Record<string, string>)["x-sdp-render-scope"]).toBe(
      "sealed-scope-a"
    );
  });

  it("discards the form on a project mismatch so a retry cannot target the new project", async () => {
    mocks.dashboardFetch.mockResolvedValue(scopeRejection("render_scope_project_mismatch"));
    renderWorkspace();

    await submitCreateForm();

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    // Exactly one submission: the recovery re-renders the workspace but must
    // not retry (or keep retryable state) behind the user's back.
    expect(mocks.dashboardFetch).toHaveBeenCalledTimes(1);
    // The open form is gone: its retained values were entered under the old
    // project, and a fresh scope names the new one.
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Create payment link" })).toBeNull()
    );
  });

  it("keeps the open form across the re-render when the scope merely went stale", async () => {
    mocks.dashboardFetch.mockResolvedValue(scopeRejection("render_scope_stale"));
    renderWorkspace();

    await submitCreateForm();

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(mocks.dashboardFetch).toHaveBeenCalledTimes(1);
    // Same project, expired scope: the form survives the re-render with its
    // values so the manual retry mints and presents a fresh scope.
    expect(screen.getByRole("heading", { name: "Create payment link" })).toBeDefined();
  });

  it("leaves the form open without re-rendering on an unrelated failure", async () => {
    const message = "The request could not be created.";
    mocks.dashboardFetch.mockResolvedValue({
      ok: false as const,
      status: 502,
      error: message,
      body: { error: { message } },
    });
    renderWorkspace();

    await submitCreateForm();

    expect(mocks.dashboardFetch).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Create payment link" })).toBeDefined();
  });
});
