// The generic notification email: title + body + optional CTA. Every producer already
// composes a server-side title/body (that's the in-app model), so one template serves
// all categories; richer per-category variants slot in behind renderNotificationEmail
// without touching the dispatcher.

import { Button, Link, Text } from "@react-email/components";
import { render } from "@react-email/render";
import { EmailLayout } from "./layout";

const styles = {
  title: {
    color: "#18181b",
    fontSize: "18px",
    fontWeight: 600 as const,
    lineHeight: "26px",
    margin: "0 0 12px",
  },
  bodyText: {
    color: "#3f3f46",
    fontSize: "14px",
    lineHeight: "22px",
    margin: "0 0 24px",
  },
  cta: {
    backgroundColor: "#18181b",
    borderRadius: "6px",
    color: "#ffffff",
    display: "inline-block",
    fontSize: "14px",
    fontWeight: 600 as const,
    padding: "10px 20px",
    textDecoration: "none",
  },
  footerText: {
    color: "#a1a1aa",
    fontSize: "12px",
    lineHeight: "18px",
    margin: "0 0 6px",
  },
  footerLink: {
    color: "#71717a",
    fontSize: "12px",
    textDecoration: "underline",
  },
} as const;

export interface NotificationEmailProps {
  title: string;
  body?: string | null;
  ctaUrl?: string | null;
  ctaLabel?: string | null;
  // Internal recipients: link to the dashboard settings page (preference matrix).
  managePreferencesUrl?: string | null;
  // External recipients (counterparty receipts): who sent this and why — required
  // context for mail that lands outside the platform.
  externalRecipientNote?: string | null;
}

export function NotificationEmail({
  title,
  body,
  ctaUrl,
  ctaLabel,
  managePreferencesUrl,
  externalRecipientNote,
}: NotificationEmailProps) {
  const footer =
    managePreferencesUrl || externalRecipientNote ? (
      <>
        {externalRecipientNote ? (
          <Text style={styles.footerText}>{externalRecipientNote}</Text>
        ) : null}
        {managePreferencesUrl ? (
          <Text style={styles.footerText}>
            <Link href={managePreferencesUrl} style={styles.footerLink}>
              Manage notification preferences
            </Link>
          </Text>
        ) : null}
      </>
    ) : undefined;

  return (
    <EmailLayout preview={title} footer={footer}>
      <Text style={styles.title}>{title}</Text>
      {body ? <Text style={styles.bodyText}>{body}</Text> : null}
      {ctaUrl ? (
        <Button href={ctaUrl} style={styles.cta}>
          {ctaLabel ?? "View in dashboard"}
        </Button>
      ) : null}
    </EmailLayout>
  );
}

export interface RenderedNotificationEmail {
  html: string;
  text: string;
}

export async function renderNotificationEmail(
  props: NotificationEmailProps
): Promise<RenderedNotificationEmail> {
  const element = <NotificationEmail {...props} />;
  return {
    html: await render(element),
    text: await render(element, { plainText: true }),
  };
}
