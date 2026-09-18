// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { AddConnectionModal } from "./add-connection-modal";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ orgId: "org_test", getToken: async () => "test-token" }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  push.mockClear();
});

function ConnectionLauncher() {
  const [isOpen, setOpen] = useState(false);
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <button type="button" onClick={() => setOpen(true)}>
        Add connection
      </button>
      <AddConnectionModal isOpen={isOpen} onClose={() => setOpen(false)} provider="privy" />
    </I18nProvider>
  );
}

function mockApi() {
  vi.stubEnv("SDP_API_BASE_URL", "https://api.example.test");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  const submit = vi
    .fn<(init?: RequestInit) => Promise<Response>>()
    .mockImplementation(async () => Response.json({ data: { connectionId: "cconn_new" } }));
  const complete = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () =>
      Response.json({ error: { message: "Completion is unavailable." } }, { status: 403 })
    );
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/v1/projects")) {
      return Response.json({ data: { projects: [{ id: "prj_1", slug: "default-sandbox" }] } });
    }
    if (String(url).endsWith("/custody/provider-credentials")) return submit(init);
    if (String(url).endsWith("/custody/connections/cconn_new/complete")) return complete();
    throw new Error(`Unexpected API request: ${url}`);
  });
  return { submit, complete };
}

async function openAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Add connection" }));
  await user.type(screen.getByLabelText("Privy app ID"), "app_test");
  await user.type(screen.getByLabelText("Privy app secret"), "secret_test");
  await user.click(screen.getByRole("button", { name: "Connect and verify" }));
}

it("offers a fresh submission after closing a refused completion and reopening", async () => {
  const { submit } = mockApi();
  const user = userEvent.setup();
  render(<ConnectionLauncher />);
  await openAndSubmit(user);
  await screen.findByText("Completion is unavailable.");
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();

  await user.click(screen.getByRole("button", { name: "Add connection" }));
  expect(screen.getByRole("button", { name: "Connect and verify" })).toBeTruthy();
  expect(screen.getByLabelText("Privy app secret")).toHaveProperty("value", "");
  await user.type(screen.getByLabelText("Privy app ID"), "app_other");
  await user.type(screen.getByLabelText("Privy app secret"), "secret_other");
  await user.click(screen.getByRole("button", { name: "Connect and verify" }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  expect(new Headers(submit.mock.calls[1]?.[0]?.headers).get("Idempotency-Key")).not.toBe(
    new Headers(submit.mock.calls[0]?.[0]?.headers).get("Idempotency-Key")
  );
});

it("keeps an unknown submission open and replays the same payload and key", async () => {
  const { submit, complete } = mockApi();
  submit.mockRejectedValueOnce(new TypeError("fetch failed"));
  complete.mockImplementation(async () =>
    Response.json({ data: { completion: { status: "success" } } })
  );
  const user = userEvent.setup();
  render(<ConnectionLauncher />);
  await openAndSubmit(user);
  const retry = await screen.findByRole("button", { name: "Retry submission" });
  const close = screen.getByRole("button", { name: "Close" });
  expect(close).toHaveProperty("disabled", true);
  await user.click(close);
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.queryByLabelText("Privy app secret")).toBeNull();

  await user.click(retry);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(submit).toHaveBeenCalledTimes(2);
  expect(submit.mock.calls[1]?.[0]?.body).toBe(submit.mock.calls[0]?.[0]?.body);
  expect(new Headers(submit.mock.calls[1]?.[0]?.headers).get("Idempotency-Key")).toBe(
    new Headers(submit.mock.calls[0]?.[0]?.headers).get("Idempotency-Key")
  );
  expect(push).toHaveBeenCalledWith("/dashboard/integrations/privy/connections/cconn_new");
});

it("blocks closing during a completion retry and releases it after a refusal", async () => {
  const { complete } = mockApi();
  const user = userEvent.setup();
  render(<ConnectionLauncher />);
  await openAndSubmit(user);
  await screen.findByText("Completion is unavailable.");
  const retry = Promise.withResolvers<Response>();
  complete.mockReturnValueOnce(retry.promise);

  await user.click(screen.getByRole("button", { name: "Check again" }));
  const close = screen.getByRole("button", { name: "Close" });
  expect(close).toHaveProperty("disabled", true);
  await user.click(close);
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeTruthy();

  retry.resolve(Response.json({ error: { message: "Try again later." } }, { status: 403 }));
  await screen.findByText("Try again later.");
  await user.click(close);
  expect(screen.queryByRole("dialog")).toBeNull();
});
