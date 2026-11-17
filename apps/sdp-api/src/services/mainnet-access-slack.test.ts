import { describe, expect, it } from "vitest";
import type { MainnetAccessRequestEmail } from "@/services/mainnet-access-email";
import {
  countryFlag,
  mainnetAccessCorrectionSlackMessage,
  mainnetAccessRequestSlackMessage,
} from "@/services/mainnet-access-slack";
import { SLACK_COLORS } from "@/services/slack-webhook";

const REQUEST: MainnetAccessRequestEmail = {
  organizationId: "org_acme",
  organizationName: "Acme <!channel>",
  requester: { userId: "user_jane", email: "jane@gmail.com", name: "Jane Doe" },
  countryCode: "SG",
  countryName: "Singapore",
  termsVersion: "2026-11-03",
  requestedAt: "2026-11-17T16:32:00.000Z",
  foundationContactEmail: null,
  useCase: "Payouts\nin USDC",
};

const OPERATOR = { operator: "ops@example.org", reason: "customer wrote in", ticket: "HOO-1" };

describe("mainnet access Slack posts", () => {
  it("draws a country's flag from its code", () => {
    expect(countryFlag("SG")).toBe("🇸🇬");
    expect(countryFlag("gb")).toBe("");
  });

  it("lays a request out with who, where, what and how to act, in amber", () => {
    const message = mainnetAccessRequestSlackMessage(REQUEST);
    const [attachment] = message.attachments;
    expect(attachment.color).toBe(SLACK_COLORS.pending);
    expect(message.text).toBe("Mainnet access request: Acme <!channel>");
    const body = JSON.stringify(attachment.blocks);
    for (const text of [
      "*Acme &lt;!channel&gt;* wants to go live on mainnet.",
      "*Requested by*\\nJane Doe\\njane@gmail.com",
      "*Jurisdiction*\\n🇸🇬 Singapore\\n_self-declared_",
      "*Foundation contact*\\nNone stated",
      "*Building*\\n>Payouts\\n>in USDC",
      ":warning: *gmail.com* is a free email provider",
      "`org_acme` · `user_jane` · requested 17 Nov 2026, 16:32 UTC",
    ]) {
      expect(body).toContain(text);
    }
    expect(body).not.toContain("<!channel>");
    const actions = attachment.blocks.find((block) => block.type === "actions");
    expect(actions).toMatchObject({
      elements: [
        { text: { text: "Open in Clerk" }, url: "https://dashboard.clerk.com", style: "primary" },
        { text: { text: "Email Jane" } },
      ],
    });
    const compose = new URL(
      (actions as { elements: { url: string }[] }).elements[1]?.url ?? "https://invalid"
    );
    expect(compose.searchParams.get("to")).toBe("jane@gmail.com");
  });

  it("leaves out the warning for a company domain, and the email button without an email", () => {
    const company = mainnetAccessRequestSlackMessage({
      ...REQUEST,
      requester: { ...REQUEST.requester, email: "jane@acme.com" },
    });
    expect(JSON.stringify(company)).not.toContain(":warning:");
    const anonymous = mainnetAccessRequestSlackMessage({
      ...REQUEST,
      requester: { userId: "user_jane", email: null, name: null },
      useCase: null,
    });
    const body = JSON.stringify(anonymous);
    expect(body).toContain("*Requested by*\\nUnknown");
    expect(body).toContain("_Not stated_");
    expect(body).not.toContain("Email ");
  });

  it("posts a corrected jurisdiction in blue, and a reset in red", () => {
    const corrected = mainnetAccessCorrectionSlackMessage({
      request: REQUEST,
      correction: { operation: "set-country", countryCode: "GB", countryName: "United Kingdom" },
      ...OPERATOR,
    });
    expect(corrected.attachments[0].color).toBe(SLACK_COLORS.corrected);
    expect(JSON.stringify(corrected)).toContain("~🇸🇬 Singapore~ → 🇬🇧 United Kingdom");

    const reset = mainnetAccessCorrectionSlackMessage({
      request: REQUEST,
      correction: { operation: "reset" },
      ...OPERATOR,
    });
    expect(reset.attachments[0].color).toBe(SLACK_COLORS.reset);
    expect(reset.text).toBe("Mainnet access request reset: Acme <!channel>");
    const body = JSON.stringify(reset);
    expect(body).toContain("Don't approve from the earlier post");
    expect(body).toContain("*Ticket*\\nHOO-1");
    expect(body).toContain(">customer wrote in");
  });
});
