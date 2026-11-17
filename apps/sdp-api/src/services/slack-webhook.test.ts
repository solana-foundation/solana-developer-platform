import { afterEach, describe, expect, it, vi } from "vitest";
import {
  contextLine,
  escapeSlackText,
  fieldsSection,
  linkButton,
  postSlackMessage,
  requestsSlackWebhookUrl,
  SLACK_COLORS,
  SlackWebhookError,
  slackMessage,
} from "@/services/slack-webhook";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/secret";
const EMPTY = slackMessage("t", SLACK_COLORS.pending, []);

function envWith(url: string | undefined): Env {
  return { ...env, SDP_REQUESTS_SLACK_WEBHOOK_URL: url };
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

describe("message helpers", () => {
  it("wraps blocks in one attachment with its bar color", () => {
    expect(slackMessage("fallback", SLACK_COLORS.daily, [contextLine("hi")])).toEqual({
      text: "fallback",
      attachments: [
        {
          color: "#9945FF",
          blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: "hi" }] }],
        },
      ],
    });
  });

  it("escapes what Slack reads as markup, so text can't mention the channel or hide a link", () => {
    expect(escapeSlackText("<!channel> & <https://evil.example|Clerk>")).toBe(
      "&lt;!channel&gt; &amp; &lt;https://evil.example|Clerk&gt;"
    );
  });

  it("escapes the message's own text, which Slack shows beside the attachment", () => {
    expect(slackMessage("Acme <!channel>", SLACK_COLORS.pending, []).text).toBe(
      "Acme &lt;!channel&gt;"
    );
  });

  it("keeps text within Slack's limits", () => {
    const section = fieldsSection(["x".repeat(2500)]);
    if (section.type !== "section") throw new Error("fieldsSection builds a section");
    const [field] = section.fields ?? [];
    expect(field?.text).toHaveLength(2000);
    expect(field?.text.endsWith("…")).toBe(true);
    expect(linkButton("y".repeat(100), "https://example.com").text.text).toHaveLength(75);
  });
});

describe("postSlackMessage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts the message as JSON", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    await postSlackMessage(WEBHOOK, EMPTY);
    expect(fetchMock).toHaveBeenCalledWith(
      WEBHOOK,
      expect.objectContaining({ method: "POST", body: JSON.stringify(EMPTY) })
    );
  });

  it("throws without the URL when Slack refuses or doesn't answer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("invalid_blocks", { status: 400 })
    );
    const refused = postSlackMessage(WEBHOOK, EMPTY);
    await expect(refused).rejects.toThrow(SlackWebhookError);
    await expect(refused).rejects.toThrow("status 400");

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError(`fetch failed ${WEBHOOK}`));
    const error = await postSlackMessage(WEBHOOK, EMPTY).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SlackWebhookError);
    if (!(error instanceof Error)) throw new Error("postSlackMessage rejects with an Error");
    expect(error.message).not.toContain("secret");
  });
});
