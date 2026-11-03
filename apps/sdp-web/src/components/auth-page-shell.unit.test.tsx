import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages, type MessageKey } from "@/i18n/messages";
import { translate } from "@/i18n/translate";

vi.mock("@/i18n/server", () => ({
  getTranslations: async () => (key: MessageKey) => translate(getMessages("en"), key),
}));

import { AuthPageShell } from "./auth-page-shell";

async function renderShell(): Promise<string> {
  return renderToStaticMarkup(await AuthPageShell({ action: null, children: "page" }));
}

describe("AuthPageShell", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("marks the beta deployment and says what beta is", async () => {
    vi.stubEnv("SDP_RELEASE_CHANNEL", "beta");

    const html = await renderShell();

    expect(html).toContain(">Beta<");
    expect(html).toContain("Beta is a devnet sandbox with its own organizations");
  });

  it.each(["stable", "experimental"])("shows no beta mark on %s", async (channel) => {
    vi.stubEnv("SDP_RELEASE_CHANNEL", channel);

    const html = await renderShell();

    expect(html).not.toContain(">Beta<");
    expect(html).not.toContain("devnet sandbox");
  });
});
