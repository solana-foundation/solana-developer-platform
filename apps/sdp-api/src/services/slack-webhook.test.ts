import { afterEach, describe, expect, it, vi } from "vitest";
import {
  escapeSlackText,
  postSlackMessage,
  requestsSlackWebhookUrl,
  SlackWebhookError,
  slackMessageFromEmail,
} from "@/services/slack-webhook";
import type { Env } from "@/types/env";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/secret";

function envWith(url: string | undefined): Env {
  return { SDP_REQUESTS_SLACK_WEBHOOK_URL: url } as Env;
}

describe("requestsSlackWebhookUrl", () => {
  it("takes a Slack webhook URL", () => {
    expect(requestsSlackWebhookUrl(envWith(` ${WEBHOOK} `))).toBe(WEBHOOK);
  });

  it.each([
    ["unset", undefined],
    ["a placeholder", "placeholder"],
    ["another host", "https://hooks.example.com/services/T000/B000/secret"],
    ["a lookalike host", "https://hooks.slack.com.example.com/services/x"],
    ["plain http", "http://hooks.slack.com/services/T000/B000/secret"],
    ["no hook", "https://hooks.slack.com/"],
  ])("reads %s as no webhook", (_, url) => {
    expect(requestsSlackWebhookUrl(envWith(url))).toBeNull();
  });
});

describe("slackMessageFromEmail", () => {
  it("lays the email out as a header, summary, fields, button and note", () => {
    const message = slackMessageFromEmail({
      preheader: "Acme asked to use mainnet.",
      heading: "Mainnet access requested",
      summary: "Acme asked to use SDP on mainnet.",
      details: [
        { label: "Organization", value: "Acme" },
        { label: "Building", value: "Payouts" },
      ],
      action: { label: "Open Clerk", url: "https://dashboard.clerk.com" },
      note: "Approve in Clerk.",
    });
    expect(message).toEqual({
      text: "Acme asked to use mainnet.",
      blocks: [
        { type: "header", text: { type: "plain_text", text: "Mainnet access requested" } },
        { type: "section", text: { type: "mrkdwn", text: "Acme asked to use SDP on mainnet." } },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: "*Organization*\nAcme" },
            { type: "mrkdwn", text: "*Building*\nPayouts" },
          ],
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Open Clerk" },
              url: "https://dashboard.clerk.com",
              style: "primary",
            },
          ],
        },
        { type: "context", elements: [{ type: "mrkdwn", text: "Approve in Clerk." }] },
      ],
    });
  });

  it("escapes customer text, so it can't mention the channel or hide a link", () => {
    const message = slackMessageFromEmail({
      preheader: "p",
      heading: "h",
      summary: "<!channel> & <https://evil.example|Clerk>",
      details: [{ label: "Organization", value: "<@U123> Acme & Co" }],
    });
    expect(JSON.stringify(message)).not.toMatch(/<[!@h]/);
    expect(message.blocks[1]).toMatchObject({
      text: { text: "&lt;!channel&gt; &amp; &lt;https://evil.example|Clerk&gt;" },
    });
    expect(escapeSlackText("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
  });

  it("keeps every value within Slack's limits", () => {
    const details = Array.from({ length: 12 }, (_, index) => ({
      label: `Detail ${index}`,
      value: "x".repeat(2500),
    }));
    const message = slackMessageFromEmail({
      preheader: "p",
      heading: "h".repeat(200),
      summary: "s",
      details,
    });
    const [header, , first, second] = message.blocks;
    expect(header).toMatchObject({ text: { text: expect.stringMatching(/^h{149}…$/) } });
    expect(first).toMatchObject({ fields: expect.any(Array) });
    if (first?.type !== "section" || second?.type !== "section") throw new Error("fields");
    expect(first.fields).toHaveLength(10);
    expect(second.fields).toHaveLength(2);
    for (const field of [...(first.fields ?? []), ...(second.fields ?? [])]) {
      expect(field.text.length).toBeLessThanOrEqual(2000);
    }
  });
});

describe("postSlackMessage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts the message as JSON", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    await postSlackMessage(WEBHOOK, { text: "t", blocks: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      WEBHOOK,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ text: "t", blocks: [] }) })
    );
  });

  it("throws without the URL when Slack refuses or doesn't answer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("invalid_blocks", { status: 400 })
    );
    const refused = postSlackMessage(WEBHOOK, { text: "t", blocks: [] });
    await expect(refused).rejects.toThrow(SlackWebhookError);
    await expect(refused).rejects.toThrow("status 400");

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError(`fetch failed ${WEBHOOK}`));
    const error = await postSlackMessage(WEBHOOK, { text: "t", blocks: [] }).catch(
      (cause: unknown) => cause
    );
    expect(error).toBeInstanceOf(SlackWebhookError);
    expect(String((error as Error).message)).not.toContain("secret");
  });
});
