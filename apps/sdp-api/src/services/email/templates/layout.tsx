// Shared email shell: flat, neutral, inline-styled (email clients ignore stylesheets).
// Matches the dashboard's flat design language — no shadows, no gradients; color is
// reserved for status, so the shell stays monochrome.

import { Body, Container, Head, Html, Preview, Section, Text } from "@react-email/components";
import type { ReactNode } from "react";

const styles = {
  body: {
    backgroundColor: "#f4f4f5",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    margin: 0,
    padding: "24px 0",
  },
  container: {
    backgroundColor: "#ffffff",
    border: "1px solid #e4e4e7",
    borderRadius: "8px",
    margin: "0 auto",
    maxWidth: "520px",
    padding: "32px",
  },
  brand: {
    color: "#71717a",
    fontSize: "13px",
    fontWeight: 600 as const,
    letterSpacing: "0.04em",
    margin: "0 0 24px",
    textTransform: "uppercase" as const,
  },
  footer: {
    borderTop: "1px solid #e4e4e7",
    color: "#a1a1aa",
    fontSize: "12px",
    lineHeight: "18px",
    marginTop: "24px",
    paddingTop: "16px",
  },
} as const;

export interface EmailLayoutProps {
  // Inbox preview line (usually the notification title).
  preview: string;
  children: ReactNode;
  // Small print under the card: preference link, external-recipient note, etc.
  footer?: ReactNode;
}

export function EmailLayout({ preview, children, footer }: EmailLayoutProps) {
  return (
    <Html lang="en">
      <Head>
        {/* Declare the (light-only) palette: clients that honor the meta stop
            force-inverting the hardcoded colors into dark-on-dark. */}
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        {/* width attribute alongside the max-width style: Outlook's Word engine
            ignores max-width on tables and would render the card edge-to-edge. */}
        <Container width={520} style={styles.container}>
          <Text style={styles.brand}>Solana Developer Platform</Text>
          {children}
          {/* Inside the Container: centering an outside Section relies on auto
              margins, which Outlook also ignores. */}
          {footer ? <Section style={styles.footer}>{footer}</Section> : null}
        </Container>
      </Body>
    </Html>
  );
}
