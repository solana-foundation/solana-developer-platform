// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RecordActionRow, RecordFacts, RecordList, RecordRow } from "./payments-record";

afterEach(() => {
  cleanup();
});

describe("RecordFacts", () => {
  it("shows each fact once, skipping empty ones, with one hidden separator between them", () => {
    const { container } = render(
      <RecordFacts facts={[null, "Singapore", "", "Singapore", undefined, "192.0.2.1"]} />
    );

    expect(container.textContent).toBe("Singapore192.0.2.1");
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });
});

describe("RecordRow and RecordActionRow help", () => {
  it("names an info button with the help text only where help is given", () => {
    render(
      <>
        <RecordList>
          <RecordRow label="Network" help="Where the payment settles">
            Devnet
          </RecordRow>
          <RecordRow label="Fee">0.01 SOL</RecordRow>
        </RecordList>
        <RecordActionRow label="Alerts" help="Emails go to every admin" />
        <RecordActionRow label="Theme" />
      </>
    );

    expect(
      screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))
    ).toEqual(["Where the payment settles", "Emails go to every admin"]);
  });
});
