import { Children, isValidElement, type ReactNode } from "react";

/**
 * An operation's samples and example responses (scripts/lib/api-reference-page.ts): beside the
 * operation and sticky on a wide page, below it on a narrow one.
 */
export function ApiPanel({ children }: { children: ReactNode }) {
  return <div className="launch-api-panel">{children}</div>;
}

function isPanel(part: ReactNode): boolean {
  return isValidElement(part) && part.type === ApiPanel;
}

/**
 * An operation's page body: its endpoint, description, fields and responses in the main column,
 * its `<ApiPanel>` in the second from 1280px. Both stay server components, so the panel is found
 * by its component.
 */
export function ApiOperation({ children }: { children: ReactNode }) {
  const parts = Children.toArray(children);
  return (
    <section className="launch-api-operation">
      <div className="launch-api-operation-main">{parts.filter((part) => !isPanel(part))}</div>
      {parts.filter(isPanel)}
    </section>
  );
}
