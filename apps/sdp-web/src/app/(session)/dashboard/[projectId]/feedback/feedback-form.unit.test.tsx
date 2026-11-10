// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDashboardUrl } from "@/test/dashboard-navigation";
import { EnglishI18n } from "@/test/i18n";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { FeedbackForm } from "./feedback-form";

const EVENT_ID = "0123456789abcdef0123456789abcdef";

const mocks = vi.hoisted(() => ({
  sentryClient: {} as object | undefined,
  captureFeedback: vi.fn<(...args: unknown[]) => string>(),
  dashboardFetch: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({ user: { primaryEmailAddress: { emailAddress: "jane@example.com" } } }),
}));
vi.mock("@sentry/nextjs", () => ({
  getClient: () => mocks.sentryClient,
  captureFeedback: mocks.captureFeedback,
}));
vi.mock("@/lib/dashboard-fetch", () => ({ dashboardFetch: mocks.dashboardFetch }));

afterEach(() => {
  cleanup();
  mocks.sentryClient = {};
  mocks.captureFeedback.mockReset();
  mocks.dashboardFetch.mockReset();
});

function renderForm() {
  setDashboardUrl(`/dashboard/${PRODUCTION_PROJECT.id}/feedback`, {});
  return render(<FeedbackForm organizationId="org_1" />, { wrapper: EnglishI18n });
}

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("no file input");
  return input;
}

const send = () => screen.getByRole("button", { name: /^Send feedback/ });

describe("FeedbackForm", () => {
  it("emails the team through the API, with the files and replay in Sentry", async () => {
    mocks.captureFeedback.mockReturnValue(EVENT_ID);
    mocks.dashboardFetch.mockResolvedValue({ ok: true, data: { data: { sent: true } } });
    const user = userEvent.setup();
    const { container } = renderForm();

    await user.click(screen.getByLabelText("An idea"));
    await user.type(screen.getByLabelText("What would you change?"), "  Show the fee first  ");
    await user.upload(fileInput(container), new File(["png"], "shot.png", { type: "image/png" }));
    await user.click(send());

    expect(await screen.findByText("Sent to the SDP team")).toBeDefined();
    expect(
      screen.getByText(
        "With the page you were on and 1 file. A reply, if there is one, goes to jane@example.com."
      )
    ).toBeDefined();
    const [, hint] = mocks.captureFeedback.mock.calls[0] ?? [];
    expect(hint).toMatchObject({
      includeReplay: true,
      attachments: [{ filename: "shot.png", contentType: "image/png" }],
    });
    const [path, request] = mocks.dashboardFetch.mock.calls[0] ?? [];
    expect(path).toBe("/api/dashboard/organizations/org_1/feedback");
    expect(request).toMatchObject({
      method: "POST",
      body: {
        category: "idea",
        message: "Show the fee first",
        attachmentCount: 1,
        sentryEventId: EVENT_ID,
      },
    });
  });

  it("keeps Send disabled until there is something to send", async () => {
    const user = userEvent.setup();
    renderForm();

    expect((send() as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("What would you change?"), "   ");
    expect((send() as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("What would you change?"), "Hi");
    expect((send() as HTMLButtonElement).disabled).toBe(false);
  });

  it("still emails the team without Sentry, and then takes no files", async () => {
    mocks.sentryClient = undefined;
    mocks.dashboardFetch.mockResolvedValue({ ok: true, data: {} });
    const user = userEvent.setup();
    const { container } = renderForm();

    expect(container.querySelector('input[type="file"]')).toBeNull();
    await user.type(screen.getByLabelText("What would you change?"), "Hello");
    await user.click(send());

    expect(await screen.findByText("Sent to the SDP team")).toBeDefined();
    expect(mocks.captureFeedback).not.toHaveBeenCalled();
    const [, request] = mocks.dashboardFetch.mock.calls[0] ?? [];
    expect((request as { body: { sentryEventId?: string } }).body.sentryEventId).toBeUndefined();
  });

  it("says SDP isn't answering when the deployment takes no feedback, and keeps the text", async () => {
    mocks.dashboardFetch.mockResolvedValue({ ok: false, status: 503, error: "x", body: null });
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText("What would you change?"), "Hello");
    await user.click(send());

    expect((await screen.findByRole("alert")).textContent).toBe(
      "SDP isn’t answering, so nothing can be sent right now."
    );
    expect((screen.getByLabelText("What would you change?") as HTMLTextAreaElement).value).toBe(
      "Hello"
    );
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
    expect(
      (screen.getByRole("button", { name: /^Attach files/ }) as HTMLButtonElement).disabled
    ).toBe(true);
  });
});
