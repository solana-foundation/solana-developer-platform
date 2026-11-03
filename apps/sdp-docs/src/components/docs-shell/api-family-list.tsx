import type { ReactNode } from "react";

/** A compact directory of API family links and descriptions, with a Markdown form. */
export function ApiFamilyList({ children }: { children: ReactNode }) {
  return <div className="launch-api-family-list">{children}</div>;
}
