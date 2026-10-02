"use client";

import { useInView, useReducedMotion } from "motion/react";
import { Fragment, useEffect, useRef } from "react";
import { useFormIn } from "@/lib/use-form-in";
import { FormLetters, letterCount } from "./form-letters";

const STEP_MS = 22;

type FormHeadingProps = {
  as?: "h2" | "h3";
  /** One entry per line of the drawn heading. */
  lines: string[];
  className?: string;
};

/**
 * A section headline whose letters form the first time it scrolls into view.
 * It is rendered solid and only hides its letters once the script is running,
 * so a heading below the fold never depends on the animation. Assistive
 * technology gets the lines as one sentence.
 */
export function FormHeading({ as: Tag = "h2", lines, className }: FormHeadingProps) {
  const ref = useRef<HTMLHeadingElement>(null);
  const reducedMotion = useReducedMotion();
  const inView = useInView(ref, { once: true, margin: "0px 0px -10% 0px", amount: 0.2 });

  useEffect(() => {
    const heading = ref.current;
    if (!heading || reducedMotion || heading.dataset.form) return;
    heading.dataset.form = "hidden";
  }, [reducedMotion]);
  useFormIn(ref, inView, STEP_MS);

  let start = 0;
  return (
    <Tag ref={ref} className={className}>
      <span className="sr-only">{lines.join(" ")}</span>
      <span aria-hidden="true">
        {lines.map((line, index) => {
          const lineStart = start;
          start += letterCount(line);
          return (
            <Fragment key={line}>
              {index > 0 ? <br /> : null}
              <FormLetters text={line} start={lineStart} stepMs={STEP_MS} />
            </Fragment>
          );
        })}
      </span>
    </Tag>
  );
}
