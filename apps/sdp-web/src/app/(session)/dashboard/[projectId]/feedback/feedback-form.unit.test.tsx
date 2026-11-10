// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import * as dashboardFetchModule from "@/lib/dashboard-fetch";
import { setDashboardUrl } from "@/test/dashboard-navigation";
import { EnglishI18n } from "@/test/i18n";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { FeedbackForm } from "./feedback-form";

const EVENT_ID = "0123456789abcdef0123456789abcdef";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
// The signed-in person is ambient: the success line names their email.
vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({ user: { primaryEmailAddress: { emailAddress: "jane@example.com" } } }),
}));

// Whether Sentry runs is a deployment constant (its DSN), and the SDK's ESM namespace cannot be
// spied on, so the SDK is the one module this test swaps: a client or none, and the event id.
const sentry = vi.hoisted(() => ({
  client: true,
  captureFeedback: vi.fn((..._args: unknown[]) => "0123456789abcdef0123456789abcdef"),
}));
vi.mock("@sentry/nextjs", () => ({
  getClient: () => (sentry.client ? {} : undefined),
  captureFeedback: sentry.captureFeedback,
}));
const captureFeedback = sentry.captureFeedback;

let dashboardFetch: MockInstance<typeof dashboardFetchModule.dashboardFetch>;

beforeEach(() => {
  sentry.client = true;
  dashboardFetch = vi.spyOn(dashboardFetchModule, "dashboardFetch");
});

afterEach(() => {
  cleanup();
  captureFeedback.mockClear();
  vi.restoreAllMocks();
});

const FROM_PATH = `/dashboard/${PRODUCTION_PROJECT.id}/payments`;

function renderForm(fromPath: string | null = FROM_PATH) {
  setDashboardUrl(`/dashboard/${PRODUCTION_PROJECT.id}/feedback`, {});
  return render(<FeedbackForm organizationId="org_1" fromPath={fromPath} />, {
    wrapper: EnglishI18n,
  });
}

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("no file input");
  return input;
}

const send = () => screen.getByRole("button", { name: /^Send feedback/ });
const messageBox = () => screen.getByLabelText("What would you change?");

describe("FeedbackForm", () => {
  it("emails the team through the API, with the files and replay in Sentry", async () => {
    dashboardFetch.mockResolvedValue({ ok: true, data: { data: { sent: true } }, status: 201 });
    const user = userEvent.setup();
    const { container } = renderForm();

    await user.click(screen.getByLabelText("An idea"));
    await user.type(messageBox(), "  Show the fee first  ");
    await user.upload(fileInput(container), new File(["png"], "shot.png", { type: "image/png" }));
    await user.click(send());

    expect(await screen.findByText("Sent to the SDP team")).toBeDefined();
    expect(
      screen.getByText(
        "With the page you were on and 1 file. A reply, if there is one, goes to jane@example.com."
      )
    ).toBeDefined();
    const [, hint] = captureFeedback.mock.calls[0] ?? [];
    expect(hint).toMatchObject({
      includeReplay: true,
      attachments: [{ filename: "shot.png", contentType: "image/png" }],
    });
    const [path, request] = dashboardFetch.mock.calls[0] ?? [];
    expect(path).toBe("/api/dashboard/organizations/org_1/feedback");
    expect(request).toMatchObject({
      method: "POST",
      body: {
        category: "idea",
        message: "Show the fee first",
        pageUrl: `${window.location.origin}${FROM_PATH}`,
        attachmentCount: 1,
        sentryEventId: EVENT_ID,
      },
    });
  });

  it("names no page when the screen was opened without one", async () => {
    dashboardFetch.mockResolvedValue({ ok: true, data: {}, status: 201 });
    const user = userEvent.setup();
    renderForm(null);

    await user.type(messageBox(), "Hello");
    await user.click(send());

    expect(
      await screen.findByText("A reply, if there is one, goes to jane@example.com.")
    ).toBeDefined();
    const [, request] = dashboardFetch.mock.calls[0] ?? [];
    expect(request).toMatchObject({ body: { message: "Hello", pageUrl: undefined } });
  });

  it("names the same Sentry event when a failed send is retried unchanged", async () => {
    dashboardFetch
      .mockResolvedValueOnce({ ok: false, status: 500, error: "Internal error", body: null })
      .mockResolvedValueOnce({ ok: true, data: {}, status: 201 });
    const user = userEvent.setup();
    const { container } = renderForm();

    await user.type(messageBox(), "Hello");
    await user.upload(fileInput(container), new File(["png"], "shot.png", { type: "image/png" }));
    await user.click(send());
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn’t send your feedback: Internal error"
    );
    await user.click(send());

    expect(await screen.findByText("Sent to the SDP team")).toBeDefined();
    expect(captureFeedback).toHaveBeenCalledTimes(1);
    const [, retry] = dashboardFetch.mock.calls[1] ?? [];
    expect(retry).toMatchObject({ body: { sentryEventId: EVENT_ID } });
  });

  it("records a new Sentry event when the feedback changed before the retry", async () => {
    dashboardFetch
      .mockResolvedValueOnce({ ok: false, status: 500, error: "Internal error", body: null })
      .mockResolvedValueOnce({ ok: true, data: {}, status: 201 });
    const user = userEvent.setup();
    renderForm();

    await user.type(messageBox(), "Hello");
    await user.click(send());
    await screen.findByRole("alert");
    await user.type(messageBox(), " again");
    await user.click(send());

    expect(await screen.findByText("Sent to the SDP team")).toBeDefined();
    expect(captureFeedback).toHaveBeenCalledTimes(2);
  });

  it("keeps Send disabled until there is something to send", async () => {
    const user = userEvent.setup();
    renderForm();

    expect(send()).toHaveProperty("disabled", true);
    await user.type(messageBox(), "   ");
    expect(send()).toHaveProperty("disabled", true);
    await user.type(messageBox(), "Hi");
    expect(send()).toHaveProperty("disabled", false);
  });

  it("holds a message over the API's 5,000 characters", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(messageBox());
    await user.paste("x".repeat(5001));
    await user.click(send());

    expect(screen.getByText("Keep it to 5,000 characters or fewer.")).toBeDefined();
    expect(dashboardFetch).not.toHaveBeenCalled();
  });

  it("disables Cancel while the feedback is on its way", async () => {
    let answer: (value: Awaited<ReturnType<typeof dashboardFetchModule.dashboardFetch>>) => void =
      () => undefined;
    dashboardFetch.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    const user = userEvent.setup();
    renderForm();

    await user.type(messageBox(), "Hello");
    await user.click(send());

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("link", { name: "Cancel" })).toBeNull();
    answer({ ok: true, data: {}, status: 201 });
    expect(await screen.findByText("Sent to the SDP team")).toBeDefined();
  });

  it("still emails the team without Sentry, and then takes no files", async () => {
    sentry.client = false;
    dashboardFetch.mockResolvedValue({ ok: true, data: {}, status: 201 });
    const user = userEvent.setup();
    const { container } = renderForm();

    expect(container.querySelector('input[type="file"]')).toBeNull();
    await user.type(messageBox(), "Hello");
    await user.click(send());

    expect(await screen.findByText("Sent to the SDP team")).toBeDefined();
    expect(captureFeedback).not.toHaveBeenCalled();
    const [, request] = dashboardFetch.mock.calls[0] ?? [];
    expect(request).toMatchObject({ body: { message: "Hello", sentryEventId: undefined } });
  });

  it("says SDP isn't answering when the deployment takes no feedback, and keeps the text", async () => {
    dashboardFetch.mockResolvedValue({ ok: false, status: 503, error: "x", body: null });
    const user = userEvent.setup();
    renderForm();

    await user.type(messageBox(), "Hello");
    await user.click(send());

    expect((await screen.findByRole("alert")).textContent).toBe(
      "SDP isn’t answering, so nothing can be sent right now."
    );
    expect(messageBox()).toHaveProperty("value", "Hello");
  });

  it("names a file it can no longer read and keeps the draft", async () => {
    const user = userEvent.setup();
    const { container } = renderForm();
    const gone = new File(["png"], "gone.png", { type: "image/png" });
    vi.spyOn(gone, "arrayBuffer").mockRejectedValue(new Error("NotReadableError"));

    await user.type(messageBox(), "Hello");
    await user.upload(fileInput(container), gone);
    await user.click(send());

    expect((await screen.findByRole("alert")).textContent).toBe(
      "gone.png can’t be read any more. Remove it and send again."
    );
    expect(captureFeedback).not.toHaveBeenCalled();
    expect(dashboardFetch).not.toHaveBeenCalled();
    expect(messageBox()).toHaveProperty("value", "Hello");
  });

  it("names a file it refuses and keeps the ones it took", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { container } = renderForm();

    await user.upload(fileInput(container), [
      new File(["x"], "notes.txt", { type: "text/plain" }),
      new File(["pdf"], "spec.pdf", { type: "application/pdf" }),
    ]);

    expect(screen.getByRole("alert").textContent).toBe("notes.txt isn’t a picture or a PDF.");
    expect(screen.getByText("spec.pdf")).toBeDefined();
    expect(screen.queryByText("notes.txt")).toBeNull();
  });

  it("keeps a file picked twice once", async () => {
    const user = userEvent.setup();
    const { container } = renderForm();
    const shot = new File(["png"], "shot.png", { type: "image/png", lastModified: 1 });

    await user.upload(fileInput(container), shot);
    await user.upload(fileInput(container), shot);

    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Remove shot.png" }));
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("takes five files at most", async () => {
    const user = userEvent.setup();
    const { container } = renderForm();
    const shots = Array.from(
      { length: 6 },
      (_, index) => new File(["png"], `shot-${index}.png`, { type: "image/png" })
    );

    await user.upload(fileInput(container), shots);

    expect(screen.getByRole("alert").textContent).toBe("Up to 5 files.");
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByRole("button", { name: /^Attach files/ })).toHaveProperty("disabled", true);
  });
});
