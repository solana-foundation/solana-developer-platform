// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { ProjectRing } from "./helius-rings.data";
import { RingCard } from "./ring-card";

const mocks = vi.hoisted(() => ({
  fetchProjectRing: vi.fn(),
  createProjectRing: vi.fn(),
}));

vi.mock("./helius-rings.data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./helius-rings.data")>()),
  fetchProjectRing: mocks.fetchProjectRing,
  createProjectRing: mocks.createProjectRing,
}));

const RING_PROGRAM = "RingProgram1111111111111111111111111111111";

const ACTIVE: ProjectRing = {
  ringProgramId: RING_PROGRAM,
  status: "active",
  auditorPublicKeyHex: "04ff00",
  failure: null,
  createdAt: "2026-08-26T12:00:00.000Z",
  updatedAt: "2026-08-26T12:00:00.000Z",
};

const FAILED: ProjectRing = {
  ...ACTIVE,
  status: "failed",
  auditorPublicKeyHex: null,
  failure: { code: "gateway_unavailable", message: "a Rings upstream service is unavailable" },
};

function renderCard(onRingChanged?: () => void) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <RingCard onRingChanged={onRingChanged} />
    </I18nProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("RingCard", () => {
  it("offers the parameter only while no ring is recorded", async () => {
    mocks.fetchProjectRing.mockResolvedValue(null);
    renderCard();

    expect(await screen.findByText(/default public ring/)).toBeTruthy();
    expect(screen.getByLabelText("Ring program id")).toBeTruthy();
    expect(mocks.createProjectRing).not.toHaveBeenCalled();
  });

  it("submits the trimmed id and re-reads the recorded outcome", async () => {
    mocks.fetchProjectRing.mockResolvedValueOnce(null).mockResolvedValue(ACTIVE);
    mocks.createProjectRing.mockResolvedValue({ ring: ACTIVE });
    renderCard();

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Ring program id"), `  ${RING_PROGRAM}  `);
    await user.click(screen.getByRole("button", { name: "Record and bring up" }));

    expect(mocks.createProjectRing).toHaveBeenCalledExactlyOnceWith({
      ringProgramId: RING_PROGRAM,
    });
    expect(await screen.findByText("Active")).toBeTruthy();
    expect(screen.getByText("04ff00")).toBeTruthy();
    // Once a ring exists, there is nothing to type: one ring per project.
    expect(screen.queryByLabelText("Ring program id")).toBeNull();
  });

  it("tells its host after a submit, so a stale ring never gates the composer", async () => {
    mocks.fetchProjectRing.mockResolvedValueOnce(null).mockResolvedValue(ACTIVE);
    mocks.createProjectRing.mockResolvedValue({ ring: ACTIVE });
    const onRingChanged = vi.fn();
    renderCard(onRingChanged);

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Ring program id"), RING_PROGRAM);
    expect(onRingChanged).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Record and bring up" }));

    expect(await screen.findByText("Active")).toBeTruthy();
    expect(onRingChanged).toHaveBeenCalledTimes(1);
  });

  it("shows the recorded failure and retries with the recorded id, not a typed one", async () => {
    mocks.fetchProjectRing.mockResolvedValueOnce(FAILED).mockResolvedValue(ACTIVE);
    mocks.createProjectRing.mockResolvedValue({ ring: ACTIVE });
    renderCard();

    expect(await screen.findByText(/upstream service is unavailable/)).toBeTruthy();

    await userEvent.setup().click(screen.getByRole("button", { name: "Retry bring-up" }));

    // The reservation is the resume point; retry must not re-point the project.
    expect(mocks.createProjectRing).toHaveBeenCalledExactlyOnceWith({
      ringProgramId: RING_PROGRAM,
    });
    expect(await screen.findByText("Active")).toBeTruthy();
  });

  it("re-points a never-active ring with a newly typed id", async () => {
    const OTHER_RING = "RingProgram2111111111111111111111111111111";
    const REPOINTED = { ...ACTIVE, ringProgramId: OTHER_RING };
    mocks.fetchProjectRing.mockResolvedValueOnce(FAILED).mockResolvedValue(REPOINTED);
    mocks.createProjectRing.mockResolvedValue({ ring: REPOINTED });
    renderCard();

    const user = userEvent.setup();
    const input = await screen.findByLabelText("Ring program id");
    expect(screen.getByText(/never been active/)).toBeTruthy();
    await user.type(input, OTHER_RING);
    await user.click(screen.getByRole("button", { name: "Record and bring up" }));

    expect(mocks.createProjectRing).toHaveBeenCalledExactlyOnceWith({
      ringProgramId: OTHER_RING,
    });
    expect(await screen.findByText("Active")).toBeTruthy();
    // Once active, the input is gone: re-pointing a live ring is refused.
    expect(screen.queryByLabelText("Ring program id")).toBeNull();
  });

  it("surfaces the server's own reason when bring-up refuses", async () => {
    mocks.fetchProjectRing.mockResolvedValueOnce(null).mockResolvedValue(FAILED);
    mocks.createProjectRing.mockResolvedValue({
      error: "ring bring-up needs a ring RPC URL and a custody message signer",
    });
    renderCard();

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Ring program id"), RING_PROGRAM);
    await user.click(screen.getByRole("button", { name: "Record and bring up" }));

    expect(await screen.findByText(/custody message signer/)).toBeTruthy();
    // The row was reserved before bring-up, so the recorded failure shows too.
    expect(await screen.findByText("Failed")).toBeTruthy();
  });

  it("answers, and re-enables the control, when the request never returns a reply", async () => {
    mocks.fetchProjectRing.mockResolvedValue(null);
    mocks.createProjectRing.mockRejectedValue(new TypeError("Failed to fetch"));
    renderCard();

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Ring program id"), RING_PROGRAM);
    await user.click(screen.getByRole("button", { name: "Record and bring up" }));

    expect(await screen.findByText("Ring bring-up failed.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Record and bring up" }) as HTMLButtonElement).disabled
    ).toBe(false);
  });
});
