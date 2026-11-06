// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStepFade } from "./use-step-fade";

const animate = vi.fn<Element["animate"]>();
let reducedMotion = false;

function Step({ step }: { step: string }) {
  const ref = useStepFade<HTMLDivElement>(step);
  return (
    <div ref={ref} data-testid="step">
      {step}
    </div>
  );
}

beforeEach(() => {
  animate.mockClear();
  reducedMotion = false;
  // jsdom implements neither Web Animations nor matchMedia.
  Element.prototype.animate = animate;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reducedMotion && query === "(prefers-reduced-motion: reduce)",
    media: query,
  }));
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Element.prototype, "animate");
  vi.unstubAllGlobals();
});

describe("useStepFade", () => {
  it("leaves the first step as it renders", () => {
    render(<Step step="details" />);

    expect(animate).not.toHaveBeenCalled();
  });

  it("fades the next step in, in opacity alone", () => {
    const { rerender } = render(<Step step="details" />);

    rerender(<Step step="review" />);

    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(screen.getByTestId("step"));
    expect(animate.mock.calls[0]?.[0]).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });

  it("does not fade a re-render of the same step", () => {
    const { rerender } = render(<Step step="details" />);

    rerender(<Step step="details" />);

    expect(animate).not.toHaveBeenCalled();
  });

  it("changes step without motion for a viewer who asks for reduced motion", () => {
    reducedMotion = true;
    const { rerender } = render(<Step step="details" />);

    rerender(<Step step="review" />);

    expect(animate).not.toHaveBeenCalled();
  });
});
