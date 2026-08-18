import { DEFAULT_SDP_DOCS_URL } from "@sdp/types";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDocsUrl } from "./docs-url";

const originalDocsUrl = process.env.NEXT_PUBLIC_SDP_DOCS_URL;

afterEach(() => {
  if (originalDocsUrl === undefined) {
    delete process.env.NEXT_PUBLIC_SDP_DOCS_URL;
  } else {
    process.env.NEXT_PUBLIC_SDP_DOCS_URL = originalDocsUrl;
  }
});

describe("resolveDocsUrl", () => {
  it("prefers the configured docs origin", () => {
    process.env.NEXT_PUBLIC_SDP_DOCS_URL = "https://docs.example.com";

    expect(resolveDocsUrl()).toBe("https://docs.example.com");
  });

  it("falls back to the published docs URL when nothing is configured", () => {
    delete process.env.NEXT_PUBLIC_SDP_DOCS_URL;

    expect(resolveDocsUrl()).toBe(DEFAULT_SDP_DOCS_URL);
  });

  it("joins a path without doubling or dropping the separator", () => {
    process.env.NEXT_PUBLIC_SDP_DOCS_URL = "https://docs.example.com/";

    expect(resolveDocsUrl("/tokens/allowlists")).toBe("https://docs.example.com/tokens/allowlists");
    expect(resolveDocsUrl("tokens/allowlists")).toBe("https://docs.example.com/tokens/allowlists");
  });

  it("keeps a configured origin that already carries a path prefix", () => {
    // The dev fallback is http://localhost:3001/docs, so the origin is not always
    // a bare host and appending must not discard the prefix.
    process.env.NEXT_PUBLIC_SDP_DOCS_URL = "http://localhost:3001/docs";

    expect(resolveDocsUrl("reference/policies")).toBe(
      "http://localhost:3001/docs/reference/policies"
    );
  });
});
