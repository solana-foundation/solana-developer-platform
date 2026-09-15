// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { ClockIcon, SendIcon } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type InstructionAction, InstructionActionButton } from "./manual-instructions-quote";

const action: InstructionAction = {
  loading: false,
  succeeded: true,
  onClick: vi.fn(),
  icon: <SendIcon />,
  idleLabel: "Send",
  busyLabel: "Sending",
  doneLabel: "Done",
};

afterEach(cleanup);

describe("InstructionActionButton", () => {
  it("marks a finished action with a check", () => {
    render(<InstructionActionButton action={action} />);

    const button = screen.getByRole("button", { name: "Done" });
    expect(button.querySelector(".lucide-circle-check")).not.toBeNull();
  });

  it("shows the done icon it is given instead of a check", () => {
    render(
      <InstructionActionButton
        action={{ ...action, doneLabel: "Waiting for approval", doneIcon: <ClockIcon /> }}
      />
    );

    const button = screen.getByRole("button", { name: "Waiting for approval" });
    expect(button.querySelector(".lucide-clock")).not.toBeNull();
    expect(button.querySelector(".lucide-circle-check")).toBeNull();
  });
});
