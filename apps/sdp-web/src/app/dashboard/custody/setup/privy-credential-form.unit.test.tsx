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
    // Stored credentials always bind to the calling project now; the form no
    // longer offers an organization scope the API would reject.
    expect(screen.queryByLabelText("Credential scope")).toBeNull();
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

  it("returns an invalid submission to the editable form, never the replay screen", async () => {
    vi.mocked(submitPrivyCredentialAction)
      .mockResolvedValueOnce({
        status: "invalid",
        message: "Fill in every required credential field.",
      })
      .mockResolvedValueOnce({ status: "success" });
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user);
    await screen.findByRole("alert");
    // Nothing was sent, so nothing needs recovering: the form stays editable
    // with the typed secret intact and no frozen replay on offer.
    expect(screen.queryByRole("button", { name: "Retry submission" })).toBeNull();
    const secret = screen.getByLabelText("Privy app secret") as HTMLInputElement;
    expect(secret.value).toBe("shh-secret");

    // Found rather than queried: the alert renders from the state update, but
    // the submit button only returns to this label once the transition behind
    // it settles, which can be a tick later. The sibling cases survive by
    // typing a correction first, which yields those ticks; this one asserts
    // and clicks straight through.
    await user.click(await screen.findByRole("button", { name: "Connect and verify" }));
    await waitFor(() => expect(submitPrivyCredentialAction).toHaveBeenCalledTimes(2));
    // The key was never spent, so the corrected submission may reuse it.
    expect(submittedKey(1)).toBe(submittedKey(0));
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

  it("keeps a refused completion re-checkable instead of resetting to a doomed resubmit", async () => {
    const onLock = vi.fn();
    vi.mocked(submitPrivyCredentialAction).mockResolvedValue({
      status: "refused",
      message: "Install checks are not enabled for this organization",
      connectionId: "conn_1",
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
    // the form (whose fresh submission would be rejected) is gone, the stored
    // credential stays re-checkable, and the lock is released so the user can
    // still back out of a refusal that needs an external fix first.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Install checks are not enabled");
    expect(screen.queryByLabelText("Privy app secret")).toBeNull();
    expect(onLock).toHaveBeenLastCalledWith(false);

    await user.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(recheckPrivyCredentialAction).toHaveBeenCalledWith("conn_1"));
    await waitFor(() => expect(push.mock.calls[0]?.[0]).toBe("/dashboard/wallets"));
    await waitFor(() => expect(onLock).toHaveBeenLastCalledWith(false));
  });

  it("dead-ends an unrecoverable wallet conflict without any retry or replacement action", async () => {
    const onLock = vi.fn();
    vi.mocked(submitPrivyCredentialAction).mockResolvedValue({
      status: "unrecoverable",
      message: "This connection is tied to a Privy wallet that cannot be reconciled.",
    });
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <PrivyCredentialForm formId="byok-unrecoverable-test" onRecoveryLockChange={onLock} />
      </I18nProvider>
    );

    await fillAndSubmit(user);
    // The server rejects replacement credentials while the provider account
    // stays pinned, so no button here can converge: the reason is shown, the
    // form is gone, and the lock releases so the user can leave.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("cannot be reconciled");
    expect(screen.queryByLabelText("Privy app secret")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(onLock).toHaveBeenLastCalledWith(false);
  });

  it("routes the corrected resubmit through replacement when the failed connection survives", async () => {
    vi.mocked(submitPrivyCredentialAction)
      .mockResolvedValueOnce({
        status: "failed",
        message: "Privy rejected these credentials.",
        connectionId: "conn_1",
      })
      .mockResolvedValueOnce({ status: "success" });
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user);
    await screen.findByRole("alert");
    // The failed connection blocks fresh submissions server-side, so the
    // corrected attempt must target it as a replacement under a new key.
    const secret = screen.getByLabelText("Privy app secret") as HTMLInputElement;
    expect(secret.value).toBe("");
    await user.type(secret, "corrected-secret");
    await user.click(screen.getByRole("button", { name: "Connect and verify" }));

    await waitFor(() => expect(submitPrivyCredentialAction).toHaveBeenCalledTimes(2));
    const first = vi.mocked(submitPrivyCredentialAction).mock.calls[0]?.[0] as FormData;
    expect(first.get("connectionId")).toBeNull();
    const second = vi.mocked(submitPrivyCredentialAction).mock.calls[1]?.[0] as FormData;
    expect(String(second.get("connectionId"))).toBe("conn_1");
    expect(submittedKey(1)).not.toBe(submittedKey(0));
  });

  it("treats a rejected submit call as an unknown outcome with the replay intact", async () => {
    const onLock = vi.fn();
    vi.mocked(submitPrivyCredentialAction)
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce({ status: "success" });
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <PrivyCredentialForm formId="byok-reject-test" onRecoveryLockChange={onLock} />
      </I18nProvider>
    );

    await fillAndSubmit(user);
    // The POST may have committed before the call rejected: the lock must hold
    // and the frozen payload must still be replayable under the same key.
    await screen.findByRole("button", { name: "Retry submission" });
    expect(onLock).toHaveBeenLastCalledWith(true);

    await user.click(screen.getByRole("button", { name: "Retry submission" }));
    await waitFor(() => expect(submitPrivyCredentialAction).toHaveBeenCalledTimes(2));
    expect(submittedKey(1)).toBe(submittedKey(0));
    await waitFor(() => expect(onLock).toHaveBeenLastCalledWith(false));
  });

  it("stays on the recovery screen when a re-check call rejects", async () => {
    vi.mocked(submitPrivyCredentialAction).mockResolvedValue({
      status: "retry_unknown",
      connectionId: "conn_1",
    });
    vi.mocked(recheckPrivyCredentialAction)
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce({ status: "success" });
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user);
    await user.click(await screen.findByRole("button", { name: "Check again" }));
    await waitFor(() => expect(recheckPrivyCredentialAction).toHaveBeenCalledTimes(1));
    // The re-check is idempotent, so a lost response keeps the same screen and
    // the same offer rather than discarding the stored credential's state.
    await user.click(await screen.findByRole("button", { name: "Check again" }));
    await waitFor(() => expect(push.mock.calls[0]?.[0]).toBe("/dashboard/wallets"));
  });

  it("offers a safe re-check instead of resubmitting after an unknown outcome", async () => {
    vi.mocked(submitPrivyCredentialAction).mockResolvedValue({
      status: "retry_unknown",
      connectionId: "conn_1",
    });
    vi.mocked(recheckPrivyCredentialAction).mockResolvedValue({ status: "success" });
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user);
    const checkAgain = await screen.findByRole("button", { name: "Check again" });
    // The credential is stored; the form (and its secret field) is gone.
    expect(screen.queryByLabelText("Privy app secret")).toBeNull();

    await user.click(checkAgain);
    await waitFor(() => expect(recheckPrivyCredentialAction).toHaveBeenCalledWith("conn_1"));
    await waitFor(() => expect(push.mock.calls[0]?.[0]).toBe("/dashboard/wallets"));
    expect(submitPrivyCredentialAction).toHaveBeenCalledTimes(1);
  });
});
