/**
 * The #sdp-requests posts for mainnet access: a request (amber), a corrected jurisdiction (blue)
 * and a reset (red). They carry what the email carries, laid out for a channel: who and where
 * first, the identifiers in a grey line last. Every customer-supplied value is escaped.
 */
import {
  emailDomain,
  formatRequestedAt,
  type MainnetAccessCorrectionEmail,
  type MainnetAccessRequestEmail,
} from "@/services/mainnet-access-email";
import {
  contextLine,
  escapeSlackText,
  fieldsSection,
  linkButton,
  mrkdwnSection,
  SLACK_COLORS,
  type SlackBlock,
  type SlackMessage,
  slackMessage,
  truncate,
} from "@/services/slack-webhook";

const CLERK_DASHBOARD_URL = "https://dashboard.clerk.com";

/** A country's flag from its ISO code, as two regional indicator symbols. */
export function countryFlag(countryCode: string): string {
  if (!/^[A-Z]{2}$/.test(countryCode)) return "";
  return String.fromCodePoint(...[...countryCode].map((letter) => 0x1f1a5 + letter.charCodeAt(0)));
}

/** A Gmail compose link to the requester, with the subject filled in. */
function composeUrl(to: string, organizationName: string): string {
  const query = new URLSearchParams({
    view: "cm",
    to,
    su: `Your SDP mainnet access request (${organizationName})`,
  });
  return `https://mail.google.com/mail/?${query.toString()}`;
}

function quote(text: string): string {
  return escapeSlackText(truncate(text, 1000))
    .split(/\r?\n/)
    .map((line) => `>${line}`)
    .join("\n");
}

function requesterLines(requester: MainnetAccessRequestEmail["requester"]): string {
  const lines = [requester.name, requester.email].filter((line): line is string => Boolean(line));
  return lines.length
    ? lines.map((line) => escapeSlackText(truncate(line, 200))).join("\n")
    : "Unknown";
}

function jurisdiction(request: MainnetAccessRequestEmail): string {
  return `${countryFlag(request.countryCode)} ${escapeSlackText(request.countryName)}`.trim();
}

function identifiers(request: MainnetAccessRequestEmail): string {
  return [
    `\`${escapeSlackText(request.organizationId)}\``,
    `\`${escapeSlackText(request.requester.userId)}\``,
    `requested ${formatRequestedAt(request.requestedAt)}`,
  ].join(" · ");
}

/** A new request: who asked, from where, what they build, and how to act on it. */
export function mainnetAccessRequestSlackMessage(request: MainnetAccessRequestEmail): SlackMessage {
  const organization = escapeSlackText(truncate(request.organizationName, 200));
  const domain = emailDomain(request.requester.email);
  const requesterEmail = request.requester.email;
  const firstName = request.requester.name?.trim().split(/\s+/)[0];
  const blocks: SlackBlock[] = [
    mrkdwnSection(`*:key: Mainnet access request*\n*${organization}* wants to go live on mainnet.`),
    fieldsSection([
      `*Requested by*\n${requesterLines(request.requester)}`,
      `*Jurisdiction*\n${jurisdiction(request)}\n_self-declared_`,
      `*Foundation contact*\n${request.foundationContactEmail ? escapeSlackText(request.foundationContactEmail) : "None stated"}`,
      `*Terms*\nv${escapeSlackText(request.termsVersion)} :white_check_mark:`,
    ]),
    mrkdwnSection(`*Building*\n${request.useCase ? quote(request.useCase) : "_Not stated_"}`),
  ];
  if (domain?.free) {
    blocks.push(
      contextLine(
        `:warning: *${escapeSlackText(domain.domain)}* is a free email provider, so there's no company domain to recognize.`
      )
    );
  }
  blocks.push({
    type: "actions",
    elements: [
      linkButton("Open in Clerk", CLERK_DASHBOARD_URL, "primary"),
      ...(requesterEmail
        ? [
            linkButton(
              firstName ? `Email ${firstName}` : "Email requester",
              composeUrl(requesterEmail, request.organizationName)
            ),
          ]
        : []),
    ],
  });
  blocks.push(
    contextLine(
      `${identifiers(request)} · Approve by setting \`enableProductionProject\` in Clerk private metadata`
    )
  );
  return slackMessage(
    `Mainnet access request: ${request.organizationName}`,
    SLACK_COLORS.pending,
    blocks
  );
}

/**
 * A correction or reset of an earlier request, so nobody approves from the earlier post: what
 * changed, who changed it and why.
 */
export function mainnetAccessCorrectionSlackMessage(
  email: MainnetAccessCorrectionEmail
): SlackMessage {
  const { request, correction } = email;
  const organization = escapeSlackText(truncate(request.organizationName, 200));
  const reset = correction.operation === "reset";
  const changedBy = `*Changed by*\n${escapeSlackText(email.operator)}`;
  const ticket = `*Ticket*\n${escapeSlackText(email.ticket)}`;
  const blocks: SlackBlock[] = reset
    ? [
        mrkdwnSection(
          `*:leftwards_arrow_with_hook: Mainnet access request reset*\n*${organization}*'s request no longer stands. Don't approve from the earlier post; a new request posts again.`
        ),
        fieldsSection([changedBy, ticket]),
      ]
    : [
        mrkdwnSection(
          `*:pencil2: Mainnet access request corrected*\n*${organization}*'s jurisdiction changed. Review the request with the new one before approving.`
        ),
        fieldsSection([
          `*Jurisdiction*\n~${jurisdiction(request)}~ → ${countryFlag(correction.countryCode)} ${escapeSlackText(correction.countryName)}`,
          changedBy,
          ticket,
        ]),
      ];
  blocks.push(mrkdwnSection(`*Reason*\n${quote(email.reason)}`));
  blocks.push(contextLine(identifiers(request)));
  return slackMessage(
    `Mainnet access request ${reset ? "reset" : "corrected"}: ${request.organizationName}`,
    reset ? SLACK_COLORS.reset : SLACK_COLORS.corrected,
    blocks
  );
}
