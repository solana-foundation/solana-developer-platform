import { describe, expect, it } from "vitest";
import { resolveMemberIdentity } from "./member-identity";

const UNNAMED = "Unnamed member";

const CLERK_PLACEHOLDER = "{{user.primary_email_address.email_address}}";

describe("resolveMemberIdentity", () => {
  it("prefers the name and keeps the email as the secondary line", () => {
    expect(
      resolveMemberIdentity(
        { id: "usr_1", name: "SDP E2E Admin", email: "admin@example.com" },
        UNNAMED
      )
    ).toEqual({
      label: "SDP E2E Admin",
      actionLabel: "SDP E2E Admin",
      secondary: "admin@example.com",
      isUnresolved: false,
    });
  });

  it("promotes the email when there is no name", () => {
    expect(
      resolveMemberIdentity({ id: "usr_1", name: null, email: "tobi@example.com" }, UNNAMED)
    ).toEqual({
      label: "tobi@example.com",
      actionLabel: "tobi@example.com",
      secondary: null,
      isUnresolved: false,
    });
  });

  it("treats a whitespace-only name as absent", () => {
    expect(
      resolveMemberIdentity({ id: "usr_1", name: "   ", email: "tobi@example.com" }, UNNAMED)
    ).toEqual({
      label: "tobi@example.com",
      actionLabel: "tobi@example.com",
      secondary: null,
      isUnresolved: false,
    });
  });

  it("falls back to a shortened user id when the email is a Clerk placeholder", () => {
    // Migration 0040 leaves a row alone when both copies of the email are corrupt,
    // so this state is reachable in a real organisation and must still name someone.
    const identity = resolveMemberIdentity(
      {
        id: "usr_d3f5b5bf-8f8c-448b-bb40-7e31b35baba1",
        name: null,
        email: CLERK_PLACEHOLDER,
      },
      UNNAMED
    );

    expect(identity.isUnresolved).toBe(true);
    expect(identity.label).toBe(UNNAMED);
    expect(identity.secondary).toBe("usr_d3f5b5bf…baba1");
    // Regression guard: a bare em-dash identified nobody and made the remove
    // confirmation read "Remove —".
    expect(identity.label).not.toBe("—");
    expect(identity.label).not.toContain("{{");
  });

  it("never leaks the placeholder as the secondary line", () => {
    const identity = resolveMemberIdentity(
      {
        id: "usr_1",
        name: "Named Person",
        email: CLERK_PLACEHOLDER,
      },
      UNNAMED
    );

    expect(identity.label).toBe("Named Person");
    expect(identity.secondary).toBeNull();
  });

  it("keeps two unresolved members apart in anything that acts on them", () => {
    // `label` is one shared string for every unresolved row, so the actions menu, the
    // remove confirmation and the success toast all have to read `actionLabel` or an
    // admin cannot tell which account they are removing.
    const first = resolveMemberIdentity(
      { id: "usr_d3f5b5bf-8f8c-448b-bb40-7e31b35baba1", name: null, email: CLERK_PLACEHOLDER },
      UNNAMED
    );
    const second = resolveMemberIdentity(
      { id: "usr_9a1c77e2-4b0d-4f61-9c3a-1de8f0447c25", name: null, email: CLERK_PLACEHOLDER },
      UNNAMED
    );

    expect(first.label).toBe(second.label);
    expect(first.actionLabel).not.toBe(second.actionLabel);
    expect(first.actionLabel).toBe(`${UNNAMED} (usr_d3f5b5bf…baba1)`);
    expect(first.actionLabel).not.toContain("{{");
  });

  it("leaves a short id untruncated", () => {
    expect(
      resolveMemberIdentity({ id: "usr_short", name: null, email: "" }, UNNAMED).secondary
    ).toBe("usr_short");
  });
});
