/** Products that use the shared docs development notice. */
export type DevelopmentProduct = "SDP" | "Earn";

/** The same development caveat in the page and its Markdown. */
export const DEVELOPMENT_NOTICE_DETAIL = "Features, API endpoints, and docs may change.";

/** The product's development status, shared by visual and text readers. */
export function developmentNoticeTitle(product: DevelopmentProduct): string {
  return `${product} is under active development.`;
}

/** A development notice for Markdown pages and AI discovery resources. */
export function developmentNoticeMarkdown(product: DevelopmentProduct): string {
  return `> **${developmentNoticeTitle(product)}** ${DEVELOPMENT_NOTICE_DETAIL}`;
}
