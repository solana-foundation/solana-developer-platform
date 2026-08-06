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

  it("mints a fresh key and clears the rejected secret after a terminal failure", async () => {
    vi.mocked(submitPrivyCredentialAction)
      .mockResolvedValueOnce({ status: "failed", message: "Privy rejected these credentials." })
      .mockResolvedValueOnce({ status: "success" });
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user);
    await screen.findByRole("alert");
    // The rejected secret must not linger for corrections to be typed onto.
    const secret = screen.getByLabelText("Privy app secret") as HTMLInputElement;
    expect(secret.value).toBe("");
    await user.type(secret, "corrected-secret");
    await user.click(screen.getByRole("button", { name: "Connect and verify" }));

    await waitFor(() => expect(submitPrivyCredentialAction).toHaveBeenCalledTimes(2));
    const second = vi.mocked(submitPrivyCredentialAction).mock.calls[1]?.[0] as FormData;
    expect(String(second.get("appSecret"))).toBe("corrected-secret");
    expect(submittedKey(1)).not.toBe(submittedKey(0));
  });

  it("freezes the payload and replays it verbatim when the outcome is unknown", async () => {
    vi.mocked(submitPrivyCredentialAction)
      .mockResolvedValueOnce({ status: "error", message: "network dropped" })
      .mockResolvedValueOnce({ status: "success" });
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user);
    // The editable form is gone: nothing can drift under the retained key.
    const retry = await screen.findByRole("button", { name: "Retry submission" });
    expect(screen.queryByLabelText("Privy app secret")).toBeNull();

    await user.click(retry);
    await waitFor(() => expect(submitPrivyCredentialAction).toHaveBeenCalledTimes(2));
    // Identical payload, identical key: a true replay.
    expect(submittedKey(1)).toBe(submittedKey(0));
    const second = vi.mocked(submitPrivyCredentialAction).mock.calls[1]?.[0] as FormData;
    expect(String(second.get("appSecret"))).toBe("shh-secret");
  });

  it("locks recovery for the parent while an outcome is unknown", async () => {
    const onLock = vi.fn();
    vi.mocked(submitPrivyCredentialAction)
      .mockResolvedValueOnce({ status: "error", message: "network dropped" })
      .mockResolvedValueOnce({ status: "success" });
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <PrivyCredentialForm formId="byok-lock-test" onRecoveryLockChange={onLock} />
      </I18nProvider>
    );

    await fillAndSubmit(user);
    // The lock engages when the POST leaves, before any outcome is known.
    expect(onLock.mock.calls[0]?.[0]).toBe(true);
    await screen.findByRole("button", { name: "Retry submission" });
    expect(onLock).toHaveBeenLastCalledWith(true);

    await user.click(screen.getByRole("button", { name: "Retry submission" }));
    await waitFor(() => expect(onLock).toHaveBeenLastCalledWith(false));
  });

  it("offers no escape from an unknown outcome except the verbatim replay", async () => {
    vi.mocked(submitPrivyCredentialAction).mockResolvedValueOnce({
      status: "error",
      message: "network dropped",
    });
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user);
    await screen.findByRole("button", { name: "Retry submission" });
    // A fresh-key submission over a committed pending connection is refused
    // server-side, so abandoning the frozen key would strand the install.
    expect(screen.queryByRole("button", { name: "Start over" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect and verify" })).toBeNull();
  });

  it("keeps a refused credential re-checkable instead of resetting to a doomed resubmit", async () => {
    const onLock = vi.fn();
    vi.mocked(submitPrivyCredentialAction).mockResolvedValue({
      status: "failed",
      message: "Install checks are not enabled for this organization",
      providerCredentialId: "pcred_1",
    });
    vi.mocked(recheckPrivyCredentialAction).mockResolvedValue({ status: "success" });
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <PrivyCredentialForm formId="byok-refused-test" onRecoveryLockChange={onLock} />
      </I18nProvider>
    );

    await fillAndSubmit(user);
    // The server refused but kept the pending connection: the reason is shown,
    // the form (whose fresh submission would be rejected) is gone, and the
    // stored credential stays re-checkable.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Install checks are not enabled");
    expect(screen.queryByLabelText("Privy app secret")).toBeNull();
    expect(onLock).toHaveBeenLastCalledWith(true);

    await user.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(recheckPrivyCredentialAction).toHaveBeenCalledWith("pcred_1"));
    await waitFor(() => expect(push.mock.calls[0]?.[0]).toBe("/dashboard/wallets"));
    await waitFor(() => expect(onLock).toHaveBeenLastCalledWith(false));
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
