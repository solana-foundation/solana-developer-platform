// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RecordActionRow, RecordFacts, RecordList, RecordRow } from "./payments-record";

afterEach(() => {
  cleanup();
});

describe("RecordFacts", () => {
  it("skips empty and repeated facts and draws a hidden dot only between the ones left", () => {
    const { container } = render(
      <RecordFacts facts={[null, "Singapore", "", "Singapore", undefined, "192.0.2.1"]} />
    );

    const leaves = Array.from(container.querySelectorAll("span span")).filter(
      (span) => span.children.length === 0
    );

    expect(
      leaves.map((leaf) => (leaf.getAttribute("aria-hidden") === "true" ? "dot" : leaf.textContent))
    ).toEqual(["Singapore", "dot", "192.0.2.1"]);
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
