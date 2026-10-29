// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { AnimatePresence } from "motion/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HeightReveal } from "./height-reveal";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
});

afterEach(cleanup);

function Reveal({ open }: { open: boolean }) {
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <HeightReveal key="details">
          <button type="button">Wallet</button>
        </HeightReveal>
      ) : null}
    </AnimatePresence>
  );
}

describe("HeightReveal", () => {
  it("keeps open content reachable", () => {
    render(<Reveal open />);

    expect(screen.getByText("Wallet").closest("[inert]")).toBeNull();
  });

  it("makes closing content inert while its exit plays", () => {
    // AnimatePresence keeps the content mounted through the exit, so Tab must not land in it.
    const { rerender } = render(<Reveal open />);
    rerender(<Reveal open={false} />);

    const closing = screen.queryByText("Wallet");
    expect(closing).not.toBeNull();
    expect(closing?.closest("[inert]")).not.toBeNull();
  });
});
