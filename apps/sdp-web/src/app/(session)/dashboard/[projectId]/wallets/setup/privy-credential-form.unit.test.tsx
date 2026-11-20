// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import useSWR, { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issuanceQueryKeys } from "@/app/(session)/dashboard/[projectId]/issuance/issuance-query-key";
import { earnQueryKeys } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-query-key";
import { paymentsQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import * as byokActions from "@/app/(session)/dashboard/[projectId]/wallets/byok-actions";
import {
  recheckPrivyCredentialAction,
  submitPrivyCredentialAction,
} from "@/app/(session)/dashboard/[projectId]/wallets/byok-actions";
import * as csrActions from "@/app/(session)/dashboard/[projectId]/wallets/setup/fireblocks-csr-actions";
import { dashboardDataResponse, stubDashboardFetch } from "@/test/dashboard-fetch";
import { dashboardRouter, setDashboardUrl } from "@/test/dashboard-navigation";
import { EnglishI18n } from "@/test/i18n";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { FreshSWRCache } from "@/test/swr";
import { generateFireblocksCsrAction } from "./fireblocks-csr-actions";
import { ByokCredentialForm } from "./privy-credential-form";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const WALLETS_HREF = `/dashboard/${PRODUCTION_PROJECT.id}/wallets`;

/** The Project's pending registration, as the dashboard route answers each read. */
const csrRead = vi.fn<() => Response | Promise<Response>>();

function renderForm(
  provider: "privy" | "fireblocks" = "privy",
  onPendingChange?: (pending: boolean) => void
) {
  return render(
    <EnglishI18n>
      <FreshSWRCache>
        <ByokCredentialForm
          formId="byok-test-form"
          provider={provider}
          onPendingChange={onPendingChange}
        />
      </FreshSWRCache>
    </EnglishI18n>
  );
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("App ID"), "app_123");
  await user.type(screen.getByLabelText("App secret"), "shh-secret");
  await user.click(screen.getByRole("button", { name: "Connect and verify" }));
}

/** The form the submit action received on its `call`th call, or the test fails. */
function submission(call: number): FormData {
  const sent = vi.mocked(submitPrivyCredentialAction).mock.calls[call];
  if (sent === undefined) throw new Error(`The submit action has no call ${call}`);
  return sent[0];
}

function submittedKey(call: number): string {
  return String(submission(call).get("idempotencyKey"));
}

/** The text input labelled `label`, or the test fails. */
function inputLabelled(label: string): HTMLInputElement {
  const input = screen.getByLabelText(label);
  if (!(input instanceof HTMLInputElement)) throw new Error(`${label} is not an input`);
  return input;
}

/** The Fireblocks registration the form would submit, or the test fails. */
function signingKeyId(): string {
  const input = document.querySelector('input[name="signingKeyId"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("No signing key field");
  return input.value;
}

/** Renders the SWR read of `cacheKey` in an `<output>` with test id `name`. */
function Inventory({
  cacheKey,
  name,
  fetcher,
}: {
  cacheKey: string | readonly string[];
  name: string;
  fetcher: () => Promise<string>;
}) {
  const { data } = useSWR(cacheKey, fetcher, {
    fallbackData: "Previous data",
    revalidateOnMount: false,
  });
  return <output data-testid={name}>{data}</output>;
}

describe("ByokCredentialForm", () => {
  beforeEach(() => {
    vi.spyOn(byokActions, "submitPrivyCredentialAction");
    vi.spyOn(byokActions, "recheckPrivyCredentialAction");
    vi.spyOn(csrActions, "generateFireblocksCsrAction");
    vi.spyOn(csrActions, "loadFireblocksVaultsAction").mockResolvedValue({
      status: "success",
      vaults: [
        { id: "0", name: "Treasury", hasSolanaWallet: true },
        { id: "7", name: "Operations", hasSolanaWallet: true },
      ],
      nextCursor: null,
    });
    cleanup();
    setDashboardUrl(`/dashboard/${PRODUCTION_PROJECT.id}/wallets/setup`, {});
    dashboardRouter.push.mockClear();
    vi.mocked(submitPrivyCredentialAction).mockReset();
    vi.mocked(recheckPrivyCredentialAction).mockReset();
    csrRead.mockReset().mockImplementation(() =>
      dashboardDataResponse(200, {
        csr: {
          id: "fbcsr_11111111-1111-4111-8111-111111111111",
          csrPem: "public-csr",
          expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        },
      })
    );
    stubDashboardFetch((request) => {
      if (request.path === "/api/dashboard/fireblocks/csr") return csrRead();
      throw new Error(`Unexpected dashboard request: ${request.path}`);
    });
    vi.mocked(generateFireblocksCsrAction).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the host informed while registration and vault discovery are in flight", async () => {
    const registration = Promise.withResolvers<Response>();
    const discovery =
      Promise.withResolvers<Awaited<ReturnType<typeof csrActions.loadFireblocksVaultsAction>>>();
    csrRead.mockReturnValueOnce(registration.promise);
    vi.mocked(csrActions.loadFireblocksVaultsAction).mockReturnValueOnce(discovery.promise);
    const pending = vi.fn();
    const user = userEvent.setup();
    renderForm("fireblocks", pending);
    expect(pending).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("button", { name: "Connect and verify" })).toHaveProperty(
      "disabled",
      true
    );
    registration.resolve(
      dashboardDataResponse(200, {
        csr: {
          id: "fbcsr_pending",
          csrPem: "public-csr",
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      })
    );
    await waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
    await user.type(screen.getByLabelText("API user ID"), "api-user");
    await user.click(screen.getByRole("button", { name: "Load vaults" }));
    expect(pending).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("button", { name: "Connect and verify" })).toHaveProperty(
      "disabled",
      true
    );
    discovery.reject(new Error("Network disconnected"));
    await waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
    expect(submitPrivyCredentialAction).not.toHaveBeenCalled();
  });

  it("reloads registration after every rejected Fireblocks attempt and connects with a fresh CSR", async () => {
    const csrs = [1, 2, 3].map((attempt) => ({
      id: `fbcsr_attempt_${attempt}`,
      csrPem: `public-csr-${attempt}`,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }));
    csrRead
      .mockReturnValueOnce(dashboardDataResponse(200, { csr: csrs[0] }))
      .mockReturnValueOnce(dashboardDataResponse(200, { csr: null }))
      .mockReturnValueOnce(dashboardDataResponse(200, { csr: null }));
    vi.mocked(generateFireblocksCsrAction)
      .mockResolvedValueOnce({ status: "success", csr: csrs[1] })
      .mockResolvedValueOnce({ status: "success", csr: csrs[2] });
    const submissions = csrs.map(() =>
      Promise.withResolvers<Awaited<ReturnType<typeof submitPrivyCredentialAction>>>()
    );
    for (const submission of submissions) {
      vi.mocked(submitPrivyCredentialAction).mockReturnValueOnce(submission.promise);
    }
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL() {
          return "blob:csr";
        }
        static revokeObjectURL() {}
      }
    );
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderForm("fireblocks");
    // Found by its idle name, so a submit still settling (named "… Loading") is not it.
    const connect = () => screen.getByRole("button", { name: "Connect and verify" });
    const generate = () => screen.getByRole("button", { name: "Generate and download CSR" });

    // Each press waits for the state that lets it act: a disabled or busy control drops it.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        // The remounted fields have read again and found no registration.
        await waitFor(() => {
          expect(generate()).toHaveProperty("disabled", false);
          expect(connect()).toHaveProperty("disabled", true);
        });
        expect(screen.queryByRole("checkbox")).toBeNull();
        expect(screen.getByLabelText("API user ID")).toHaveProperty("value", "");
        await user.click(generate());
      }
      await waitFor(() => expect(signingKeyId()).toBe(csrs[attempt].id));
      await user.type(screen.getByLabelText("API user ID"), `api-user-${attempt}`);
      await user.click(screen.getByRole("button", { name: "Load vaults" }));
      await user.click(await screen.findByRole("checkbox", { name: /Treasury/ }));
      await waitFor(() => expect(connect()).toHaveProperty("disabled", false));
      await user.click(connect());
      await waitFor(() => expect(submitPrivyCredentialAction).toHaveBeenCalledTimes(attempt + 1));
      // The submit keeps its words and spins while the check runs.
      expect(
        screen.getByRole("button", { name: /^Connect and verify/ }).getAttribute("aria-busy")
      ).toBe("true");
      expect(submission(attempt).get("signingKeyId")).toBe(csrs[attempt].id);
      if (attempt > 0) {
        expect(submission(attempt).get("connectionId")).toBe("cconn_test");
        expect(submittedKey(attempt)).not.toBe(submittedKey(attempt - 1));
      }
      // Finish the parent transition before interacting with the remounted CSR form.
      // The action being called (or the child appearing) does not mean it has settled.
      await act(async () => {
        if (attempt < 2) {
          submissions[attempt].resolve({
            status: "failed",
            message: "Rejected",
            connectionId: "cconn_test",
          });
        } else {
          submissions[attempt].resolve({ status: "success", connectionId: "cconn_test" });
        }
      });
    }
    await waitFor(() => expect(dashboardRouter.push).toHaveBeenCalledWith(WALLETS_HREF));
  });

  it.each(["invalid", "error"] as const)(
    "retains the Fireblocks CSR and submission key for an %s result",
    async (status) => {
      vi.mocked(submitPrivyCredentialAction)
        .mockResolvedValueOnce({ status, message: "Try again" })
        .mockResolvedValueOnce({ status: "success", connectionId: "cconn_test" });
      const user = userEvent.setup();
      renderForm("fireblocks");
      await screen.findByRole("button", { name: "Download CSR" });
      await user.type(screen.getByLabelText("API user ID"), "api-user");
      await user.click(screen.getByRole("button", { name: "Load vaults" }));
      await user.click(await screen.findByRole("checkbox", { name: /Treasury/ }));
      await user.click(screen.getByRole("button", { name: "Connect and verify" }));
      if (status === "invalid") {
        await screen.findByText("Try again");
        expect(screen.getByLabelText("API user ID")).toHaveProperty("value", "api-user");
        expect(screen.getByRole("checkbox", { name: /Treasury/ })).toHaveProperty("checked", true);
      }
      await user.click(
        await screen.findByRole("button", {
          name: status === "error" ? "Retry submission" : "Connect and verify",
        })
      );
      await waitFor(() => expect(dashboardRouter.push).toHaveBeenCalledWith(WALLETS_HREF));
      expect(submission(1).get("signingKeyId")).toBe(submission(0).get("signingKeyId"));
      expect(submittedKey(1)).toBe(submittedKey(0));
    }
  );

  it("submits the generated Fireblocks key reference and never requests a private key", async () => {
    vi.mocked(submitPrivyCredentialAction).mockResolvedValue({
      status: "failed",
      message: "Rejected",
    });
    const user = userEvent.setup();
    renderForm("fireblocks");
    expect(screen.queryByLabelText("App ID")).toBeNull();
    await screen.findByRole("button", { name: "Download CSR" });
    await user.type(screen.getByLabelText("API user ID"), "fireblocks-key");
    expect(screen.queryByLabelText("Vault account ID")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Load vaults" }));
    await user.click(await screen.findByRole("checkbox", { name: /Treasury/ }));
    await user.click(screen.getByRole("checkbox", { name: /Operations/ }));
    await user.click(screen.getByRole("button", { name: "Connect and verify" }));
    await screen.findByText("Rejected");
    const submitted = submission(0);
    expect(submitted.get("provider")).toBe("fireblocks");
    expect(submitted.get("vaultAccountId")).toBe("0");
    expect(submitted.getAll("fireblocksVaultAccountIds")).toEqual(["0", "7"]);
    expect(submitted.has("walletLabel")).toBe(false);
    expect(submitted.get("signingKeyId")).toBe("fbcsr_11111111-1111-4111-8111-111111111111");
    expect(submitted.has("apiSecretPem")).toBe(false);
    expect(screen.queryByLabelText("RSA private key (PEM)")).toBeNull();
  });

  it("asks for the secret in a masked field that starts empty", () => {
    renderForm();

    const secret = inputLabelled("App secret");
    expect(secret.type).toBe("password");
    expect(secret.value).toBe("");
  });

  it("submits the credentials under an idempotency key and routes to wallets on success", async () => {
    vi.mocked(submitPrivyCredentialAction).mockResolvedValue({
      status: "success",
      connectionId: "cconn_test",
    });
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user);

    await waitFor(() => expect(dashboardRouter.push).toHaveBeenCalledWith(WALLETS_HREF));
    expect(Object.fromEntries(submission(0))).toEqual({
      provider: "privy",
      appId: "app_123",
      appSecret: "shh-secret",
      walletLabel: "",
      credentialLabel: "Privy credential",
      idempotencyKey: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      ),
    });
  });

  it("refreshes wallet inventories in the current project after install without replaying commands", async () => {
    vi.mocked(submitPrivyCredentialAction).mockResolvedValue({
      status: "success",
      connectionId: "conn_test",
    });
    const walletRead = vi.fn(async () => "New Connection wallet");
    const otherProjectRead = vi.fn(async () => "Other project changed");
    const command = vi.fn(async () => "Replayed command");
    const user = userEvent.setup();
    render(
      <EnglishI18n>
        <SWRConfig value={{ provider: () => new Map() }}>
          <ByokCredentialForm formId="byok-test-form" />
          <Inventory
            cacheKey={paymentsQueryKeys.actionWallets()}
            name="payments"
            fetcher={walletRead}
          />
          <Inventory cacheKey={earnQueryKeys.fundingWallets()} name="earn" fetcher={walletRead} />
          <Inventory
            cacheKey={issuanceQueryKeys.authorityWallets({ tokenId: "token" })}
            name="issuance"
            fetcher={walletRead}
          />
          <Inventory
            cacheKey={paymentsQueryKeys.createTransfer()}
            name="command"
            fetcher={command}
          />
        </SWRConfig>
        <SWRConfig value={{ provider: () => new Map() }}>
          <Inventory
            cacheKey={paymentsQueryKeys.actionWallets()}
            name="other-project"
            fetcher={otherProjectRead}
          />
        </SWRConfig>
      </EnglishI18n>
    );

    await fillAndSubmit(user);

    await waitFor(() =>
      expect(screen.getByTestId("payments").textContent).toBe("New Connection wallet")
    );
    expect(screen.getByTestId("earn").textContent).toBe("New Connection wallet");
    expect(screen.getByTestId("issuance").textContent).toBe("New Connection wallet");
    expect(screen.getByTestId("other-project").textContent).toBe("Previous data");
    expect(screen.getByTestId("command").textContent).toBe("Previous data");
    expect(otherProjectRead).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    expect(submitPrivyCredentialAction).toHaveBeenCalledTimes(1);
  });

  it("mints a fresh key and clears the rejected secret after a terminal failure", async () => {
    vi.mocked(submitPrivyCredentialAction)
      .mockResolvedValueOnce({ status: "failed", message: "Privy rejected these credentials." })
      .mockResolvedValueOnce({ status: "success", connectionId: "cconn_test" });
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user);
    await screen.findByRole("alert");
    // The rejected secret must not linger for corrections to be typed onto.
    const secret = inputLabelled("App secret");
    expect(secret.value).toBe("");
    await user.type(secret, "corrected-secret");
    await user.click(screen.getByRole("button", { name: "Connect and verify" }));

    await waitFor(() => expect(submitPrivyCredentialAction).toHaveBeenCalledTimes(2));
    expect(submission(1).get("appSecret")).toBe("corrected-secret");
    expect(submittedKey(1)).not.toBe(submittedKey(0));
  });

  it("returns an invalid submission to the editable form, never the replay screen", async () => {
    vi.mocked(submitPrivyCredentialAction)
      .mockResolvedValueOnce({
        status: "invalid",
        message: "Fill in every required credential field.",
      })
      .mockResolvedValueOnce({ status: "success", connectionId: "cconn_test" });
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user);
    await screen.findByRole("alert");
    // Nothing was sent, so nothing needs recovering: the form stays editable
    // with the typed secret intact and no frozen replay on offer.
    expect(screen.queryByRole("button", { name: "Retry submission" })).toBeNull();
    expect(inputLabelled("App secret").value).toBe("shh-secret");

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
    const onLock = vi.fn();
    vi.mocked(submitPrivyCredentialAction)
      .mockResolvedValueOnce({ status: "error", message: "network dropped" })
      .mockResolvedValueOnce({ status: "success", connectionId: "cconn_test" });
    const user = userEvent.setup();
    render(
      <EnglishI18n>
        <ByokCredentialForm formId="byok-lock-test" onRecoveryLockChange={onLock} />
      </EnglishI18n>
    );

    await fillAndSubmit(user);
    // The lock engages when the POST leaves, before any outcome is known.
    expect(onLock.mock.calls).toContainEqual([true]);
    // The editable form is gone, and with it any fresh-key resubmit: a committed pending
    // connection would refuse one, so the verbatim replay is the only way on.
    const retry = await screen.findByRole("button", { name: "Retry submission" });
    expect(screen.queryByLabelText("App secret")).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect and verify" })).toBeNull();
    expect(onLock).toHaveBeenLastCalledWith(true);

    await user.click(retry);
    await waitFor(() => expect(submitPrivyCredentialAction).toHaveBeenCalledTimes(2));
    // Identical payload, identical key: a true replay.
    expect(submittedKey(1)).toBe(submittedKey(0));
    expect(submission(1).get("appSecret")).toBe("shh-secret");
    await waitFor(() => expect(onLock).toHaveBeenLastCalledWith(false));
  });

  it("keeps a refused completion re-checkable instead of resetting to a doomed resubmit", async () => {
    const onLock = vi.fn();
    vi.mocked(submitPrivyCredentialAction).mockResolvedValue({
      status: "refused",
      message: "Install checks are not enabled for this organization",
      connectionId: "conn_1",
    });
    vi.mocked(recheckPrivyCredentialAction).mockResolvedValue({
      status: "success",
      connectionId: "cconn_test",
    });
    const user = userEvent.setup();
    render(
      <EnglishI18n>
        <ByokCredentialForm formId="byok-refused-test" onRecoveryLockChange={onLock} />
      </EnglishI18n>
    );

    await fillAndSubmit(user);
    // The server refused but kept the pending connection: the reason is shown,
    // the form (whose fresh submission would be rejected) is gone, the stored
    // credential stays re-checkable, and the lock is released so the user can
    // still back out of a refusal that needs an external fix first.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Install checks are not enabled");
    expect(screen.queryByLabelText("App secret")).toBeNull();
    expect(onLock).toHaveBeenLastCalledWith(false);

    await user.click(await screen.findByRole("button", { name: "Check again" }));
    await waitFor(() => expect(recheckPrivyCredentialAction).toHaveBeenCalledWith("conn_1"));
    await waitFor(() => expect(dashboardRouter.push).toHaveBeenCalledWith(WALLETS_HREF));
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
      <EnglishI18n>
        <ByokCredentialForm formId="byok-unrecoverable-test" onRecoveryLockChange={onLock} />
      </EnglishI18n>
    );

    await fillAndSubmit(user);
    // The server rejects replacement credentials while the provider account
    // stays pinned, so no button here can converge: the reason is shown, the
    // form is gone, and the lock releases so the user can leave.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("cannot be reconciled");
    expect(screen.queryByLabelText("App secret")).toBeNull();
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
      .mockResolvedValueOnce({ status: "success", connectionId: "cconn_test" });
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user);
    await screen.findByRole("alert");
    // The failed connection blocks fresh submissions server-side, so the
    // corrected attempt must target it as a replacement under a new key.
    const secret = inputLabelled("App secret");
    expect(secret.value).toBe("");
    await user.type(secret, "corrected-secret");
    await user.click(screen.getByRole("button", { name: "Connect and verify" }));

    await waitFor(() => expect(submitPrivyCredentialAction).toHaveBeenCalledTimes(2));
    expect(submission(0).get("connectionId")).toBeNull();
    expect(submission(1).get("connectionId")).toBe("conn_1");
    expect(submittedKey(1)).not.toBe(submittedKey(0));
  });

  it("treats a rejected submit call as an unknown outcome with the replay intact", async () => {
    const onLock = vi.fn();
    vi.mocked(submitPrivyCredentialAction)
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce({ status: "success", connectionId: "cconn_test" });
    const user = userEvent.setup();
    render(
      <EnglishI18n>
        <ByokCredentialForm formId="byok-reject-test" onRecoveryLockChange={onLock} />
      </EnglishI18n>
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
      .mockResolvedValueOnce({ status: "success", connectionId: "cconn_test" });
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user);
    await user.click(await screen.findByRole("button", { name: "Check again" }));
    await waitFor(() => expect(recheckPrivyCredentialAction).toHaveBeenCalledTimes(1));
    // The re-check is idempotent, so a lost response keeps the same screen and
    // the same offer rather than discarding the stored credential's state.
    await user.click(await screen.findByRole("button", { name: "Check again" }));
    await waitFor(() => expect(dashboardRouter.push).toHaveBeenCalledWith(WALLETS_HREF));
  });

  it("offers a safe re-check instead of resubmitting after an unknown outcome", async () => {
    vi.mocked(submitPrivyCredentialAction).mockResolvedValue({
      status: "retry_unknown",
      connectionId: "conn_1",
    });
    vi.mocked(recheckPrivyCredentialAction).mockResolvedValue({
      status: "success",
      connectionId: "cconn_test",
    });
    const user = userEvent.setup();
    renderForm();

    await fillAndSubmit(user);
    const checkAgain = await screen.findByRole("button", { name: "Check again" });
    // The credential is stored; the form (and its secret field) is gone.
    expect(screen.queryByLabelText("App secret")).toBeNull();

    await user.click(checkAgain);
    await waitFor(() => expect(recheckPrivyCredentialAction).toHaveBeenCalledWith("conn_1"));
    await waitFor(() => expect(dashboardRouter.push).toHaveBeenCalledWith(WALLETS_HREF));
    expect(submitPrivyCredentialAction).toHaveBeenCalledTimes(1);
  });
});
