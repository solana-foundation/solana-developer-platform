// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { clearStoredApiKeySecrets } from "@/lib/playground-api-keys";
import { usePlaygroundApiKeySecret } from "@/lib/use-playground-api-key-secret";
import { PlaygroundApiKeySelector } from "./playground-api-key-selector";

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
  selectedPlaygroundApiKeyId: "key_test" as string | null,
  setSelectedPlaygroundApiKeyId: vi.fn(),
}));

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => workspace,
}));

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
    clearStoredApiKeySecrets();
    workspace.selectedPlaygroundApiKeyId = "key_test";
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("attaches a pasted secret to the selected key and publishes it to the playground", () => {
    const view = render(ui());
    const secretInput = view.getByLabelText("API key value") as HTMLInputElement;

    fireEvent.change(secretInput, { target: { value: "Bearer sk_test_session_secret" } });

    expect(secretInput.value).toBe("sk_test_session_secret");
    expect(view.getByTestId("selected-secret").textContent).toBe("sk_test_session_secret");

    fireEvent.change(secretInput, { target: { value: "" } });

    expect(view.getByTestId("selected-secret").textContent).toBe("");
  });

  it("does not reuse a secret for a different key with the same display prefix", () => {
    const view = render(ui());
    const secretInput = view.getByLabelText("API key value") as HTMLInputElement;

    fireEvent.change(secretInput, { target: { value: "sk_test_workspace_secret" } });
    workspace.selectedPlaygroundApiKeyId = "key_other_workspace";
    view.rerender(ui());

    expect(secretInput.value).toBe("");
    expect(view.getByTestId("selected-secret").textContent).toBe("");
  });
});
