// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { ProjectRing } from "./helius-rings.data";
import { RingCard } from "./ring-card";

const mocks = vi.hoisted(() => ({
  createProjectRing: vi.fn(),
}));

vi.mock("./helius-rings.data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./helius-rings.data")>()),
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

function renderCard(ring: ProjectRing | null, onChanged: () => void = vi.fn()) {
  const view = render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <RingCard ring={ring} onChanged={onChanged} />
    </I18nProvider>
  );
  return { view, onChanged };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("RingCard", () => {
  it("offers the parameter only while no ring is recorded", () => {
    renderCard(null);

    expect(screen.getByText(/default public ring/)).toBeTruthy();
    expect(screen.getByLabelText("Ring program id")).toBeTruthy();
    expect(mocks.createProjectRing).not.toHaveBeenCalled();
  });

  it("shows the recorded ring and hides the input once it is active", () => {
    renderCard(ACTIVE);

    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("04ff00")).toBeTruthy();
    // Once active, there is nothing to type: re-pointing a live ring is refused.
    expect(screen.queryByLabelText("Ring program id")).toBeNull();
  });

  it("submits the trimmed id and tells its host, so a stale ring never gates the composer", async () => {
    mocks.createProjectRing.mockResolvedValue({ ring: ACTIVE });
    const onChanged = vi.fn();
    renderCard(null, onChanged);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Ring program id"), `  ${RING_PROGRAM}  `);
    expect(onChanged).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Record and bring up" }));

    expect(mocks.createProjectRing).toHaveBeenCalledExactlyOnceWith({
      ringProgramId: RING_PROGRAM,
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("shows the recorded failure and retries with the recorded id, not a typed one", async () => {
    mocks.createProjectRing.mockResolvedValue({ ring: ACTIVE });
    const onChanged = vi.fn();
    renderCard(FAILED, onChanged);

    expect(screen.getByText(/upstream service is unavailable/)).toBeTruthy();

    await userEvent.setup().click(screen.getByRole("button", { name: "Retry bring-up" }));

    // The reservation is the resume point; retry must not re-point the project.
    expect(mocks.createProjectRing).toHaveBeenCalledExactlyOnceWith({
      ringProgramId: RING_PROGRAM,
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("re-points a never-active ring with a newly typed id", async () => {
    const OTHER_RING = "RingProgram2111111111111111111111111111111";
    mocks.createProjectRing.mockResolvedValue({
      ring: { ...ACTIVE, ringProgramId: OTHER_RING },
    });
    renderCard(FAILED);

    const user = userEvent.setup();
    const input = screen.getByLabelText("Ring program id");
    expect(screen.getByText(/never been active/)).toBeTruthy();
    await user.type(input, OTHER_RING);
    await user.click(screen.getByRole("button", { name: "Record and bring up" }));

    expect(mocks.createProjectRing).toHaveBeenCalledExactlyOnceWith({
      ringProgramId: OTHER_RING,
    });
  });

  it("surfaces the server's own reason when bring-up refuses", async () => {
    mocks.createProjectRing.mockResolvedValue({
      error: "ring bring-up needs a ring RPC URL and a custody message signer",
    });
    renderCard(null);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Ring program id"), RING_PROGRAM);
    await user.click(screen.getByRole("button", { name: "Record and bring up" }));

    expect(await screen.findByText(/custody message signer/)).toBeTruthy();
  });

  it("answers, and re-enables the control, when the request never returns a reply", async () => {
    mocks.createProjectRing.mockRejectedValue(new TypeError("Failed to fetch"));
    renderCard(null);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Ring program id"), RING_PROGRAM);
    await user.click(screen.getByRole("button", { name: "Record and bring up" }));

    expect(await screen.findByText("Ring bring-up failed.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Record and bring up" }) as HTMLButtonElement).disabled
    ).toBe(false);
  });
});
