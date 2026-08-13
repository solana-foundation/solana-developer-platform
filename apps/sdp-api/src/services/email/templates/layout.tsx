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
    color: "#a1a1aa",
    fontSize: "12px",
    lineHeight: "18px",
    margin: "24px auto 0",
    maxWidth: "520px",
    padding: "0 32px",
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
      <Head />
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.brand}>Solana Developer Platform</Text>
          {children}
        </Container>
        {footer ? <Section style={styles.footer}>{footer}</Section> : null}
      </Body>
    </Html>
  );
}
