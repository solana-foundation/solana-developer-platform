// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages, translate } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { StackSection } from "./stack-section";

const motion = vi.hoisted(() => ({ reduced: false, inView: false }));

vi.mock("motion/react", () => ({
  useReducedMotion: () => motion.reduced,
  useInView: () => motion.inView,
}));

const messages = getMessages("en");
const t = (key: Parameters<typeof translate<typeof messages>>[1]) => translate(messages, key);

beforeEach(() => {
  vi.useFakeTimers();
  motion.reduced = false;
  motion.inView = false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderStack() {
  return render(
    <I18nProvider locale="en" messages={messages}>
      <StackSection t={t} />
    </I18nProvider>
  );
}

function heading() {
  return screen.getByRole("heading", { level: 2, name: "One integration across the stack." });
}

describe("StackSection", () => {
  it("names the heading with both lines as one sentence", () => {
    renderStack();

    expect(heading()).toBeTruthy();
  });

  it("reads the partner flow as a sentence, not as arrows", () => {
    renderStack();

    expect(screen.getByText("Partner APIs, through SDP, to your product")).toBeTruthy();
    expect(screen.getAllByText("→").every((arrow) => arrow.getAttribute("aria-hidden"))).toBe(true);
  });

  it("hides the heading's letters until it is seen, then forms them", () => {
    const { rerender } = renderStack();
    expect(heading().getAttribute("data-form")).toBe("hidden");

    motion.inView = true;
    rerender(
      <I18nProvider locale="en" messages={messages}>
        <StackSection t={t} />
      </I18nProvider>
    );
    act(() => vi.runAllTimers());

    expect(heading().getAttribute("data-form")).toBe("solid");
  });

  it("leaves everything in place under reduced motion", () => {
    motion.reduced = true;
    renderStack();

    expect(heading().getAttribute("data-form")).toBeNull();
    for (const block of document.querySelectorAll("[data-rise]")) {
      expect(block.getAttribute("data-rise")).toBe("shown");
    }
  });

  it("lists every partner once for assistive technology", () => {
    renderStack();
    const marquee = screen.getByRole("region", { name: "Partners on the platform" });

    const lists = marquee.querySelectorAll("ul");
    expect(lists).toHaveLength(2);
    expect(lists[1].getAttribute("aria-hidden")).toBe("true");
    expect(within(marquee).getAllByRole("listitem")).toHaveLength(27);
  });

  it("pauses and resumes the partner list", () => {
    renderStack();
    const track = screen.getByRole("region", { name: "Partners on the platform" })
      .firstElementChild as HTMLElement;

    fireEvent.click(screen.getByRole("button", { name: "Pause the partner list" }));
    expect(track.getAttribute("data-paused")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Play the partner list" }));
    expect(track.getAttribute("data-paused")).toBe("false");
  });
});
