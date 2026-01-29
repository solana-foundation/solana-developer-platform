/**
 * Invitation email template using React Email
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

export interface InvitationEmailProps {
  inviterEmail?: string;
  organizationName?: string;
  role: string;
  inviteUrl: string;
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

export function InvitationEmail({
  inviterEmail,
  organizationName,
  role,
  inviteUrl,
  expiresAt,
}: InvitationEmailProps) {
  const orgLabel = organizationName ?? "the organization";
  const intro = inviterEmail
    ? `${inviterEmail} invited you to join ${orgLabel} as ${role}.`
    : `You've been invited to join ${orgLabel} as ${role}.`;

  return (
    <Html>
      <Head />
      <Preview>You're invited to join {orgLabel}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section>
            <Text style={text}>{intro}</Text>
            <Text style={text}>
              This invite expires at <strong>{expiresAt}</strong>.
            </Text>
            <Button style={button} href={inviteUrl}>
              Accept Invitation
            </Button>
            <Text style={footer}>
              If you were not expecting this invite, you can safely ignore this email.
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
 * Render the invitation email to HTML and plain text
 */
export async function renderInvitationEmail(props: InvitationEmailProps): Promise<RenderedEmail> {
  const orgLabel = props.organizationName ?? "the organization";
  const intro = props.inviterEmail
    ? `${props.inviterEmail} invited you to join ${orgLabel} as ${props.role}.`
    : `You've been invited to join ${orgLabel} as ${props.role}.`;

  return {
    html: await render(<InvitationEmail {...props} />),
    text: `${intro}\n\nAccept the invitation (expires at ${props.expiresAt}):\n${props.inviteUrl}`,
    subject: `You're invited to join ${orgLabel}`,
  };
}
