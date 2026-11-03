/** Shared development notice for the docs home and API reference. */
export function DevelopmentNotice() {
  return (
    <aside className="launch-docs-development-notice" aria-label="Development notice">
      <span className="launch-docs-development-dot" aria-hidden="true" />
      <p>
        <strong>SDP is under active development.</strong> Features, API endpoints, and docs may
        change.
      </p>
    </aside>
  );
}
