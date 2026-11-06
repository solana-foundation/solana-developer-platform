import type { ReactNode } from "react";

/** A three-part funds diagram whose source stays readable as Markdown. */
export function EarnFlow({ children }: { children: ReactNode }) {
  return (
    <figure className="launch-earn-flow" aria-label="Flow of funds">
      {children}
    </figure>
  );
}

/** Linked guide choices, with the same titles and descriptions in Markdown. */
export function GuideCards({ children }: { children: ReactNode }) {
  return <div className="launch-guide-cards">{children}</div>;
}
