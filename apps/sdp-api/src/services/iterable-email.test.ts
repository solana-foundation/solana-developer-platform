import { describe, expect, it } from "vitest";
import { plainTextToHtml } from "./iterable-email";

describe("plainTextToHtml", () => {
  it("escapes every character HTML reads", () => {
    expect(plainTextToHtml(`<b>x</b> & "y" 'z'`)).toBe(
      "&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot; &#39;z&#39;"
    );
  });

  it("keeps line breaks", () => {
    expect(plainTextToHtml("Line one\nLine two\r\nLine three")).toBe(
      "Line one<br>\nLine two<br>\nLine three"
    );
  });
});
