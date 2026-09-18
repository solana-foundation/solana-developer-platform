import "server-only";

/**
 * Link unfurlers (Slack, iMessage, X, Discord, ...) fetch anonymously, so a
 * shared link only renders a card if the page shell is readable without Basic
 * auth. The shell carries branding and metadata only: every API route stays
 * protected, so a spoofed crawler gets the same empty shell a real one does.
 * Search engines are deliberately absent: the demo must never be indexed.
 */
const LINK_PREVIEW_AGENTS =
  /\b(Slackbot|Twitterbot|facebookexternalhit|Facebot|LinkedInBot|Discordbot|TelegramBot|WhatsApp|Embedly|Iframely)\b/i;

export function isLinkPreviewRequest(request: {
  method: string;
  pathname: string;
  userAgent: string | null;
}): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    request.pathname === "/" &&
    request.userAgent !== null &&
    LINK_PREVIEW_AGENTS.test(request.userAgent)
  );
}
