import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HomepageCtas } from "./homepage-ctas";

const labels = {
  contactUsLabel: "Contact us",
  joinWaitlistLabel: "Join the waitlist",
  trySdpLabel: "Try SDP",
};

describe("HomepageCtas", () => {
  it("renders only the waitlist CTA when open signup is disabled", () => {
    const markup = renderToStaticMarkup(<HomepageCtas {...labels} openSignup={false} />);

    expect(markup).toContain("Join the waitlist");
    expect(markup).not.toContain("Try SDP");
    expect(markup).not.toContain("Contact us");
  });

  it("renders signup and contact CTAs when open signup is enabled", () => {
    const markup = renderToStaticMarkup(<HomepageCtas {...labels} openSignup />);

    expect(markup).toContain('href="/sign-up"');
    expect(markup).toContain("Try SDP");
    expect(markup).toContain("Contact us");
    expect(markup).not.toContain("Join the waitlist");
  });
});
