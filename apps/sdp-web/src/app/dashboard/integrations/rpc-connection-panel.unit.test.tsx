// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
const updateOrganizationRpcSettingsAction = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));
vi.mock("@/app/dashboard/settings/actions", () => ({
  updateOrganizationRpcSettingsAction: (formData: FormData) =>
    updateOrganizationRpcSettingsAction(formData),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    loading: vi.fn(),
    success: vi.fn(),
  }),
}));
// The relay probe is shared code exercised by the settings form; the panel only
// has to decide whether to offer it.
vi.mock("@/lib/rpc-connection", () => ({
  RpcTestResultPanel: () => <div data-testid="rpc-test-result" />,
  runRpcProviderTest: vi.fn(async () => ({
    status: "success" as const,
    message: "ok",
    requestedProvider: "helius" as const,
  })),
}));

import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { RpcConnectionPanel } from "./rpc-connection-panel";

function renderPanel(props: Partial<ComponentProps<typeof RpcConnectionPanel>> = {}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
  return render(
    <RpcConnectionPanel
      activeProvider="helius"
      canManage
      isEnabledInDeployment
      organizationId="org_1"
      provider="helius"
      status="active"
      {...props}
    />,
    { wrapper }
  );
}

beforeEach(() => {
  refresh.mockClear();
  updateOrganizationRpcSettingsAction.mockReset();
  updateOrganizationRpcSettingsAction.mockResolvedValue({
    status: "success",
    message: "saved",
    savedRpcProvider: "alchemy",
  });
});

afterEach(cleanup);

describe("RpcConnectionPanel", () => {
  it("offers the relay test only on the provider the organization actually runs", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "Test connection" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use this provider" })).toBeNull();
    expect(screen.getByText(/runs through this provider/)).toBeTruthy();
  });

  it("names the active provider on a page for a different one", () => {
    renderPanel({ provider: "alchemy", status: "available" });
    // Reading Alchemy's page must not leave you guessing what is live.
    expect(screen.getByText("This organization currently runs on Helius.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use this provider" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
  });

  it("switches the organization onto the provider whose page this is", async () => {
    const user = userEvent.setup();
    renderPanel({ provider: "alchemy", status: "available" });

    await user.click(screen.getByRole("button", { name: "Use this provider" }));

    expect(updateOrganizationRpcSettingsAction).toHaveBeenCalledTimes(1);
    const formData = updateOrganizationRpcSettingsAction.mock.calls[0][0] as FormData;
    expect(formData.get("rpcProvider")).toBe("alchemy");
    expect(formData.get("organizationId")).toBe("org_1");
    // The server render owns the active provider; without a refresh the page
    // would keep claiming the old one is live.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("offers the way back to SDP RPC from a vendor page", async () => {
    const user = userEvent.setup();
    // The catalog lists `default` alongside the vendors, so this page exists
    // and is the only route back off a vendor now that the Settings dropdown
    // is gone. Without it an organization on Helius was stuck there.
    renderPanel({ provider: "default", status: "available" });

    expect(screen.getByText("This organization currently runs on Helius.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Use this provider" }));

    const formData = updateOrganizationRpcSettingsAction.mock.calls[0][0] as FormData;
    expect(formData.get("rpcProvider")).toBe("default");
  });

  it("gives a non-admin the state but no way to change it", () => {
    renderPanel({ canManage: false, provider: "alchemy", status: "available" });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/only admins can change them/)).toBeTruthy();
  });

  it("does not let a read-only member invoke the relay probe", () => {
    // Testing reaches an upstream provider; a member who may only read state
    // must not be able to spend that call.
    renderPanel({ canManage: false });
    expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
  });

  it("says the saved provider is stranded instead of offering a dead test", () => {
    // The catalog marks the saved provider active whatever the deployment
    // holds, so without this the page offers a probe that silently measures a
    // different provider.
    renderPanel({ isEnabledInDeployment: false });
    expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
    expect(screen.getByText(/falling back to another provider/)).toBeTruthy();
    // ...and must not simultaneously claim traffic runs through it.
    expect(screen.queryByText(/runs through this provider/)).toBeNull();
    expect(screen.getByText("This organization is set to use this provider.")).toBeTruthy();
  });

  it("explains an unconfigured provider instead of offering a dead switch", () => {
    renderPanel({ provider: "triton", status: "not_configured" });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/does not hold an endpoint/)).toBeTruthy();
  });

  it("does not switch when the save fails", async () => {
    updateOrganizationRpcSettingsAction.mockResolvedValue({
      status: "error",
      message: "nope",
    });
    const user = userEvent.setup();
    renderPanel({ provider: "alchemy", status: "available" });

    await user.click(screen.getByRole("button", { name: "Use this provider" }));

    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByText("This organization currently runs on Helius.")).toBeTruthy();
  });
});
