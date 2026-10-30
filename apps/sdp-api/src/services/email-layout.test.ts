import { describe, expect, it } from "vitest";
import { type EmailContent, escapeHtml, renderEmailHtml, renderEmailText } from "./email-layout";

const CONTENT: EmailContent = {
  preheader: "Acme asked to use mainnet.",
  heading: "Mainnet access requested",
  summary: "Acme <Payments> & Co asked to use SDP on mainnet.",
  details: [
    { label: "Organization", value: `Acme <Payments> & "Co"` },
    { label: "Jurisdiction", value: "Singapore (SG)" },
  ],
  action: { label: "Open Clerk", url: "https://dashboard.clerk.com" },
  note: "Replying reaches the requester.",
};

describe("escapeHtml", () => {
  it("escapes every character HTML reads", () => {
    expect(escapeHtml(`<b>x</b> & "y" 'z'`)).toBe(
      "&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot; &#39;z&#39;"
    );
  });

  it("keeps line breaks", () => {
    expect(escapeHtml("Line one\nLine two\r\nLine three")).toBe(
      "Line one<br>Line two<br>Line three"
    );
  });
});

describe("renderEmailHtml", () => {
  it("escapes customer-supplied text in every field", () => {
    const html = renderEmailHtml(CONTENT);
    expect(html).not.toContain("<Payments>");
    expect(html).toContain("Acme &lt;Payments&gt; &amp; &quot;Co&quot;");
    expect(html).toContain("Acme &lt;Payments&gt; &amp; Co asked to use SDP on mainnet.");
  });

  it("renders each detail as a labelled row and the action as one link", () => {
    const html = renderEmailHtml(CONTENT);
    expect(html.match(/<tr>\n<td/g)).toHaveLength(2);
    expect(html).toContain('<a href="https://dashboard.clerk.com"');
    expect(html).toContain(">Open Clerk</a>");
  });

  it.each(["javascript:alert(1)", "http://platform.example/dashboard", "not a url"])(
    "refuses an action link to %s",
    (url) => {
      expect(() => renderEmailHtml({ ...CONTENT, action: { label: "Open", url } })).toThrow();
    }
  );

  it("links over http to a local dashboard", () => {
    const url = "http://localhost:3000/dashboard";
    expect(renderEmailHtml({ ...CONTENT, action: { label: "Open", url } })).toContain(
      `href="${url}"`
    );
  });
});

describe("renderEmailText", () => {
  it("lays the same content out as plain text", () => {
    expect(renderEmailText(CONTENT)).toBe(
      [
        "Mainnet access requested",
        "Acme <Payments> & Co asked to use SDP on mainnet.",
        'Organization: Acme <Payments> & "Co"\nJurisdiction: Singapore (SG)',
        "Open Clerk: https://dashboard.clerk.com",
        "Replying reaches the requester.",
        "Sent by Solana Developer Platform, Solana Foundation.",
      ].join("\n\n")
    );
  });
});
