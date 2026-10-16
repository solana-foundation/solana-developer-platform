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
const LOOKUP_TABLE = "LookupTab1e11111111111111111111111111111111";

const ACTIVE: ProjectRing = {
  id: "hrr_1",
  name: "treasury",
  ringProgramId: RING_PROGRAM,
  status: "active",
  auditorPublicKeyHex: "04ff00",
  lookupTableAddress: LOOKUP_TABLE,
  failure: null,
  createdAt: "2026-08-26T12:00:00.000Z",
  updatedAt: "2026-08-26T12:00:00.000Z",
};

const FAILED: ProjectRing = {
  ...ACTIVE,
  id: "hrr_2",
  name: "payroll",
  status: "failed",
  auditorPublicKeyHex: null,
  lookupTableAddress: null,
  failure: { code: "gateway_unavailable", message: "a Rings upstream service is unavailable" },
};

function renderCard(rings: ProjectRing[], onChanged: () => void = vi.fn()) {
  const view = render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <RingCard rings={rings} onChanged={onChanged} />
    </I18nProvider>
  );
  return { view, onChanged };
}

async function fillForm(name: string, ringProgramId: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Ring name"), name);
  await user.type(screen.getByLabelText("Ring program id"), ringProgramId);
  await user.click(screen.getByRole("button", { name: "Record and bring up" }));
}

async function openList() {
  await userEvent.setup().click(screen.getByRole("button", { name: /View custom rings/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("RingCard", () => {
  it("offers the add form while no ring is recorded", () => {
    renderCard([]);

    expect(screen.getByText(/default ring/)).toBeTruthy();
    expect(screen.getByLabelText("Ring name")).toBeTruthy();
    expect(screen.getByLabelText("Ring program id")).toBeTruthy();
    expect(mocks.createProjectRing).not.toHaveBeenCalled();
  });

  it("lists every recorded ring by name in the dialog and keeps the add form on the card", async () => {
    renderCard([ACTIVE, FAILED]);

    // The add form stays on the card; only the list moves into the dialog.
    expect(screen.getByLabelText("Ring name")).toBeTruthy();

    await openList();

    // treasury is both a list row and (as the default selection) the detail header.
    expect(screen.getAllByText("treasury").length).toBeGreaterThan(0);
    expect(screen.getByText("payroll")).toBeTruthy();
    // The first ring is selected by default, so its detail is shown.
    expect(screen.getByText("04ff00")).toBeTruthy();
    expect(screen.getByText(LOOKUP_TABLE)).toBeTruthy();
  });

  it("shows a ring's detail when its row in the dialog is selected", async () => {
    renderCard([ACTIVE, FAILED]);
    await openList();

    // treasury (active) is selected first; payroll's failure is not shown yet.
    expect(screen.queryByText(/upstream service is unavailable/)).toBeNull();

    await userEvent.setup().click(screen.getByRole("button", { name: /payroll/ }));

    expect(screen.getByText(/upstream service is unavailable/)).toBeTruthy();
  });

  it("submits the trimmed name and id and tells its host", async () => {
    mocks.createProjectRing.mockResolvedValue({ ring: ACTIVE });
    const onChanged = vi.fn();
    renderCard([], onChanged);

    await fillForm("  treasury  ", `  ${RING_PROGRAM}  `);

    expect(mocks.createProjectRing).toHaveBeenCalledExactlyOnceWith({
      name: "treasury",
      ringProgramId: RING_PROGRAM,
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("refuses the reserved name before any request leaves the page", async () => {
    renderCard([]);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Ring name"), "default");
    await user.type(screen.getByLabelText("Ring program id"), RING_PROGRAM);

    // "default" names the default ring; the button never arms.
    expect(
      (screen.getByRole("button", { name: "Record and bring up" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(mocks.createProjectRing).not.toHaveBeenCalled();
  });

  it("shows the recorded failure and retries with the recorded name and id", async () => {
    mocks.createProjectRing.mockResolvedValue({ ring: { ...FAILED, status: "active" } });
    const onChanged = vi.fn();
    renderCard([FAILED], onChanged);

    await openList();
    expect(screen.getByText(/upstream service is unavailable/)).toBeTruthy();

    await userEvent.setup().click(screen.getByRole("button", { name: "Retry bring-up" }));

    // The reservation is the resume point; retry must not re-point the ring.
    expect(mocks.createProjectRing).toHaveBeenCalledExactlyOnceWith({
      name: "payroll",
      ringProgramId: RING_PROGRAM,
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("re-points a never-active ring by re-using its name with a new id", async () => {
    const OTHER_RING = "RingProgram2111111111111111111111111111111";
    mocks.createProjectRing.mockResolvedValue({
      ring: { ...FAILED, ringProgramId: OTHER_RING },
    });
    renderCard([FAILED]);

    expect(screen.getByText(/never been active/)).toBeTruthy();
    await fillForm("payroll", OTHER_RING);

    expect(mocks.createProjectRing).toHaveBeenCalledExactlyOnceWith({
      name: "payroll",
      ringProgramId: OTHER_RING,
    });
  });

  it("surfaces the server's own reason when bring-up refuses", async () => {
    mocks.createProjectRing.mockResolvedValue({
      error: "ring bring-up needs a Ring RPC URL in the project's Helius Rings configuration",
    });
    renderCard([]);

    await fillForm("treasury", RING_PROGRAM);

    expect(await screen.findByText(/Ring RPC URL/)).toBeTruthy();
  });

  it("answers, and re-enables the control, when the request never returns a reply", async () => {
    mocks.createProjectRing.mockRejectedValue(new TypeError("Failed to fetch"));
    renderCard([]);

    await fillForm("treasury", RING_PROGRAM);

    expect(await screen.findByText("Ring bring-up failed.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Record and bring up" }) as HTMLButtonElement).disabled
    ).toBe(false);
  });
});
