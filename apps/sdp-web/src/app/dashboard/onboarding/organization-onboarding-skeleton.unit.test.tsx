import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrganizationOnboardingSkeleton } from "./organization-onboarding-skeleton";

describe("OrganizationOnboardingSkeleton", () => {
  it("holds the five-card RPC onboarding geometry", () => {
    const markup = renderToStaticMarkup(<OrganizationOnboardingSkeleton />);

    expect(markup).toContain('data-loading-layout="organization-onboarding"');
    expect(markup.match(/data-loading-provider-card="true"/g)).toHaveLength(5);
    expect(markup).not.toContain('data-loading-layout="home"');
  });
});
