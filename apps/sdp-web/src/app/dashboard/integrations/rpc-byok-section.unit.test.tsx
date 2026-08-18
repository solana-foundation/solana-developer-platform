// @vitest-environment jsdom

import type { SafeRpcConnection } from "@sdp/types";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const submitRpcConnectionAction = vi.fn();
const activateRpcConnectionAction = vi.fn();
const deactivateRpcConnectionAction = vi.fn();

vi.mock("./rpc-connection-actions", () => ({
  submitRpcConnectionAction: (fd: FormData) => submitRpcConnectionAction(fd),
  activateRpcConnectionAction: (fd: FormData) => activateRpcConnectionAction(fd),
  deactivateRpcConnectionAction: (fd: FormData) => deactivateRpcConnectionAction(fd),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), loading: vi.fn(), success: vi.fn() }),
}));

import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { RpcByokSection } from "./rpc-byok-section";

function connection(overrides: Partial<SafeRpcConnection> = {}): SafeRpcConnection {
  return {
    id: "rconn_1",
    provider: "helius",
    scope: "organization",
    projectId: null,
    network: "devnet",
    status: "active",
    isDefault: true,
    displayMetadata: { endpointHost: "tenant.example", apiKeySuffix: "1234" },
    lastCheck: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    activatedAt: "2026-08-16T00:00:00.000Z",
    deactivatedAt: null,
    providerCredential: { id: "pcred_1", label: "Production key", status: "active" },
    ...overrides,
  };
}

function renderSection(props: Partial<ComponentProps<typeof RpcByokSection>> = {}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
  return render(<RpcByokSection canManage connections={[]} provider="helius" {...props} />, {
    wrapper,
  });
}

beforeEach(() => {
  submitRpcConnectionAction.mockReset();
  activateRpcConnectionAction.mockReset();
  deactivateRpcConnectionAction.mockReset();
  submitRpcConnectionAction.mockResolvedValue({ status: "success", connection: connection() });
  activateRpcConnectionAction.mockResolvedValue({ status: "success", connection: connection() });
  deactivateRpcConnectionAction.mockResolvedValue({ status: "success", connection: connection() });
});

afterEach(cleanup);

describe("RpcByokSection", () => {
  it("keeps the credential form collapsed until asked for", async () => {
    const user = userEvent.setup();
    renderSection();

    const toggle = screen.getByRole("button", { name: "Add connection" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // A page that is mostly status should not sit with a secret field open.
    expect(screen.queryByRole("button", { name: "Save connection" })).toBeNull();

    await user.click(toggle);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save connection" })).toBeTruthy();
  });

  it("collapses again once the credential is saved", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Add connection" }));
    await user.type(screen.getByRole("textbox", { name: /Connection name/i }), "Prod");
    await user.type(screen.getByLabelText(/API key/i), "tenant-key-9999");
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    expect(screen.queryByRole("button", { name: "Save connection" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add connection" })).toBeTruthy();
  });

  it("says the organization is on SDP's credentials when it has none of its own", () => {
    renderSection();
    expect(screen.getByText(/running on SDP's/)).toBeTruthy();
  });

  it("submits the key the organization typed", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Add connection" }));
    await user.type(screen.getByRole("textbox", { name: /Connection name/i }), "Prod");
    // A password input has no textbox role, so it is reached by label text.
    await user.type(screen.getByLabelText(/API key/i), "tenant-key-9999");
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    expect(submitRpcConnectionAction).toHaveBeenCalledTimes(1);
    const sent = submitRpcConnectionAction.mock.calls[0][0] as FormData;
    expect(sent.get("apiKey")).toBe("tenant-key-9999");
    expect(sent.get("provider")).toBe("helius");
    expect(sent.get("network")).toBe("devnet");
  });

  it("clears the key field after a successful save so it is never re-shown", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Add connection" }));
    await user.type(screen.getByRole("textbox", { name: /Connection name/i }), "Prod");
    const key = screen.getByLabelText(/API key/i) as HTMLInputElement;
    await user.type(key, "tenant-key-9999");
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    expect(key.value).toBe("");
  });

  it("does not ask for an endpoint a provider publishes for every account", async () => {
    const user = userEvent.setup();
    renderSection({ provider: "helius" });

    await user.click(screen.getByRole("button", { name: "Add connection" }));
    expect(screen.queryByRole("textbox", { name: /Endpoint URL/i })).toBeNull();
  });

  it("asks for an endpoint when the provider issues an account-specific one", async () => {
    const user = userEvent.setup();
    renderSection({ provider: "quicknode" });

    await user.click(screen.getByRole("button", { name: "Add connection" }));
    expect(screen.getByRole("textbox", { name: /Endpoint URL/i })).toBeTruthy();
  });

  it("lets the key be revealed so a typo is catchable before saving", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Add connection" }));
    const key = screen.getByLabelText(/API key/i) as HTMLInputElement;
    expect(key.type).toBe("password");

    await user.click(screen.getByRole("button", { name: "Reveal key" }));
    expect(key.type).toBe("text");

    await user.click(screen.getByRole("button", { name: "Hide key" }));
    expect(key.type).toBe("password");
  });

  it("masks a stored credential down to a host and suffix", () => {
    renderSection({ connections: [connection()] });
    expect(screen.getByText(/tenant\.example/)).toBeTruthy();
    expect(screen.getByText(/1234/)).toBeTruthy();
    expect(screen.getByText("Serving traffic")).toBeTruthy();
  });

  it("offers activation for a connection that is not yet serving", async () => {
    const user = userEvent.setup();
    renderSection({ connections: [connection({ status: "pending", isDefault: false })] });

    await user.click(screen.getByRole("button", { name: "Use this connection" }));
    expect(activateRpcConnectionAction).toHaveBeenCalledTimes(1);
  });

  it("gives a non-admin the connections but no controls", () => {
    renderSection({ canManage: false, connections: [connection()] });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Only organization administrators/)).toBeTruthy();
  });

  it("surfaces a redacted failure code rather than a provider response", () => {
    renderSection({
      connections: [
        connection({
          status: "failed",
          isDefault: false,
          lastCheck: { status: "failed", at: null, failureCode: "provider_rejected_credentials" },
        }),
      ],
    });
    expect(screen.getByText("provider_rejected_credentials")).toBeTruthy();
  });

  it("says the credentials could not be read rather than claiming there are none", () => {
    // An empty array is a claim; a failed read is not. Telling an organization
    // with stored credentials that it has none is the worse of the two.
    renderSection({ connections: null });

    expect(screen.getByText(/could not be loaded/)).toBeTruthy();
    expect(screen.queryByText(/running on SDP's/)).toBeNull();
  });

  it("tells a member the list is admin-only instead of asking them to reload", () => {
    // The internal routes are org:admin for reads too, so a member's request
    // was always going to 403. Rendering that as a failed read told everyone
    // below admin to reload a page that could never load for them.
    renderSection({ canManage: false, connections: "restricted" });

    expect(screen.getByText(/Only organization administrators can see/)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
    expect(screen.queryByText(/running on SDP's/)).toBeNull();
  });
});
