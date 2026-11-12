import {
  DEVELOPMENT_NOTICE_DETAIL,
  type DevelopmentProduct,
  developmentNoticeTitle,
} from "@/lib/development-notice";

/** Shared development notice for SDP and Earn documentation. */
export function DevelopmentNotice({ product = "SDP" }: { product?: DevelopmentProduct }) {
  return (
    <aside className="launch-docs-development-notice" aria-label="Development notice">
      <span className="launch-docs-development-dot" aria-hidden="true" />
      <p>
        <strong>{developmentNoticeTitle(product)}</strong> {DEVELOPMENT_NOTICE_DETAIL}
      </p>
    </aside>
  );
}
