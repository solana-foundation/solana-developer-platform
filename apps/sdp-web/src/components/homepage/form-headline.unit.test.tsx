// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const motion = vi.hoisted(() => ({ reduced: false }));

vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useInView: () => false,
  useReducedMotion: () => motion.reduced,
}));

import { FormHeadline, splitHeadline } from "./form-headline";

beforeEach(() => {
  motion.reduced = false;
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("splitHeadline", () => {
  it("numbers letters across parts and keeps words whole", () => {
    const { pieces, letterCount } = splitHeadline([
      "Issue it.",
      { lineBreak: true },
      { text: "Earn on it", className: "sel" },
    ]);

    expect(letterCount).toBe(16);
    expect(pieces).toHaveLength(3);
    expect(pieces[1]).toEqual({ key: "p1", lineBreak: true });
    const last = pieces[2];
    if (!last || "lineBreak" in last) throw new Error("expected a run");
    expect(last.className).toBe("sel");
    const firstWord = last.items[0];
    if (!firstWord || firstWord === " ") throw new Error("expected a word");
    expect(firstWord.letters[0]?.index).toBe(8);
  });
});

describe("FormHeadline", () => {
  it("gives screen readers the sentence once and hides the letters", () => {
    render(<FormHeadline as="h1" parts={["The interface", { lineBreak: true }, "to finance"]} />);

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toContain("The interface to finance");
    expect(heading.querySelector("[aria-hidden='true']")).not.toBeNull();
    expect(heading.querySelector(".sr-only")?.textContent).toBe("The interface to finance");
  });

  it("forms in stages once started", () => {
    render(<FormHeadline parts={["Hello"]} start />);
    const heading = screen.getByRole("heading", { level: 2 });

    expect(heading.dataset.state).toBe("hidden");
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(heading.dataset.state).toBe("outline");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(heading.dataset.state).toBe("solid");
  });

  it("stays hidden until started", () => {
    render(<FormHeadline parts={["Hello"]} start={false} />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.getByRole("heading").dataset.state).toBe("hidden");
  });

  it("goes straight to solid under reduced motion", () => {
    motion.reduced = true;
    render(<FormHeadline parts={["Hello"]} start />);

    expect(screen.getByRole("heading").dataset.state).toBe("solid");
  });

  it("forms on the CSS clock from first paint when given `formAt`, and never by timers", () => {
    render(<FormHeadline as="h1" parts={["Hello"]} formAt={700} stagger={30} />);
    const heading = screen.getByRole("heading", { level: 1 });

    expect(heading.dataset.state).toBe("paint");
    expect(heading.style.getPropertyValue("--form-start")).toBe("700ms");
    /* five letters at 30ms, half of it */
    expect(heading.style.getPropertyValue("--form-spread")).toBe("75");
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(heading.dataset.state).toBe("paint");
  });

  it("marks each letter for the page's noscript style", () => {
    render(<FormHeadline parts={["Hi there"]} />);

    expect(screen.getByRole("heading").querySelectorAll("[data-form-letter]")).toHaveLength(7);
  });
});
