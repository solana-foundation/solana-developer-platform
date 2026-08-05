// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  recheckPrivyCredentialAction,
  submitPrivyCredentialAction,
} from "@/app/dashboard/custody/byok-actions";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { PrivyCredentialForm } from "./privy-credential-form";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

vi.mock("@/app/dashboard/custody/byok-actions", () => ({
  submitPrivyCredentialAction: vi.fn(),
  recheckPrivyCredentialAction: vi.fn(),
}));

function renderForm() {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <PrivyCredentialForm formId="byok-test-form" />
    </I18nProvider>
  );
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Privy app ID"), "app_123");
  await user.type(screen.getByLabelText("Privy app secret"), "shh-secret");
  await user.click(screen.getByRole("button", { name: "Connect and verify" }));
}

function submittedKey(call: number): string {
  const formData = vi.mocked(submitPrivyCredentialAction).mock.calls[call]?.[0] as FormData;
  return String(formData.get("idempotencyKey"));
}

describe("PrivyCredentialForm", () => {
  beforeEach(() => {
    cleanup();
    push.mockClear();
    vi.mocked(submitPrivyCredentialAction).mockReset();
    vi.mocked(recheckPrivyCredentialAction).mockReset();
  });

  it("renders the shared field definitions with a write-only secret", () => {
    renderForm();

    expect(screen.getByLabelText("Credential label")).toHaveProperty(
      "defaultValue",
      "Privy credential"
    );
    const secret = screen.getByLabelText("Privy app secret") as HTMLInputElement;
    expect(secret.type).toBe("password");
    expect(secret.value).toBe("");
    expect(screen.getByLabelText("Credential scope")).toBeTruthy();
  });

  it("submits with an idempotency key and routes to wallets on success", async () => {
    vi.mocked(submitPrivyCredentialAction).mockResolvedValue({ status: "success" });
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user);

    await waitFor(() => expect(push.mock.calls[0]?.[0]).toBe("/dashboard/wallets"));
    expect(submittedKey(0)).toMatch(/[0-9a-f-]{36}/);
  });

  it("mints a fresh idempotency key after a terminal failure", async () => {
    vi.mocked(submitPrivyCredentialAction)
      .mockResolvedValueOnce({ status: "failed", message: "Privy rejected these credentials." })
      .mockResolvedValueOnce({ status: "success" });
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user);
    await screen.findByRole("alert");
    // The invalid credential was removed server-side; resubmitting must be a
    // new submission, not a replay of the rejected one.
    await user.type(screen.getByLabelText("Privy app secret"), "corrected-secret");
    await user.click(screen.getByRole("button", { name: "Connect and verify" }));

    await waitFor(() => expect(submitPrivyCredentialAction).toHaveBeenCalledTimes(2));
    expect(submittedKey(1)).not.toBe(submittedKey(0));
  });

  it("offers a safe re-check instead of resubmitting after an unknown outcome", async () => {
    vi.mocked(submitPrivyCredentialAction).mockResolvedValue({
      status: "retry_unknown",
      providerCredentialId: "pcred_1",
    });
    vi.mocked(recheckPrivyCredentialAction).mockResolvedValue({ status: "success" });
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user);
    const checkAgain = await screen.findByRole("button", { name: "Check again" });
    // The credential is stored; the form (and its secret field) is gone.
    expect(screen.queryByLabelText("Privy app secret")).toBeNull();

    await user.click(checkAgain);
    await waitFor(() => expect(recheckPrivyCredentialAction).toHaveBeenCalledWith("pcred_1"));
    await waitFor(() => expect(push.mock.calls[0]?.[0]).toBe("/dashboard/wallets"));
    expect(submitPrivyCredentialAction).toHaveBeenCalledTimes(1);
  });
});
