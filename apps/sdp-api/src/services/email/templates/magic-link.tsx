/**
 * Magic link email template using React Email
 */

import {
  Body,
  Button,
  Container,
  Head,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import { render } from "@react-email/render";

export interface MagicLinkEmailProps {
  verifyUrl: string;
  expiresAt: string;
}

const main = {
  backgroundColor: "#f6f9fc",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, sans-serif',
};

const container = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  padding: "40px 20px",
  marginTop: "40px",
  marginBottom: "40px",
  borderRadius: "8px",
  maxWidth: "465px",
};

const text = {
  color: "#333",
  fontSize: "16px",
  lineHeight: "24px",
  marginBottom: "24px",
};

const button = {
  backgroundColor: "#000",
  borderRadius: "6px",
  color: "#fff",
  fontSize: "16px",
  fontWeight: 600,
  textDecoration: "none",
  textAlign: "center" as const,
  display: "block",
  padding: "12px 24px",
};

const footer = {
  color: "#666",
  fontSize: "12px",
  lineHeight: "20px",
  marginTop: "32px",
};

export function MagicLinkEmail({ verifyUrl, expiresAt }: MagicLinkEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Your magic link to sign in</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section>
            <Text style={text}>
              Use this magic link to sign in. It expires at <strong>{expiresAt}</strong>.
            </Text>
            <Button style={button} href={verifyUrl}>
              Sign In
            </Button>
            <Text style={footer}>
              If you did not request this link, you can safely ignore this email.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export interface RenderedEmail {
  html: string;
  text: string;
  subject: string;
}

/**
 * Render the magic link email to HTML and plain text
 */
export async function renderMagicLinkEmail(props: MagicLinkEmailProps): Promise<RenderedEmail> {
  return {
    html: await render(<MagicLinkEmail {...props} />),
    text: `Use this magic link to sign in (expires at ${props.expiresAt}):\n\n${props.verifyUrl}`,
    subject: "Your magic link",
  };
}
