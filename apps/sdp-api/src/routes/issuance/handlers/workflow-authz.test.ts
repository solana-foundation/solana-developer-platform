import type { Permission } from "@sdp/types";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../helpers";
import { assertWorkflowActionPermitted, permissionForWorkflowAction } from "./workflow-authz";

// Minimal stand-in for the authenticated context: getAuth() reads the apiKey binding.
function contextWith(permissions: Permission[] | ["*"]): AppContext {
  return {
    get: (key: string) =>
      key === "apiKey"
        ? { id: "key_test", organizationId: "org_test", projectId: "prj_test", permissions }
        : undefined,
  } as unknown as AppContext;
}

// `member` in the org role model: read + write, no admin.
const MEMBER: Permission[] = ["tokens:read", "tokens:write"];
const ADMIN: Permission[] = ["tokens:read", "tokens:write", "tokens:admin"];

describe("workflow action authorization", () => {
  it.each(["allowlist_add", "allowlist_remove", "send_webhook", "notify", "record"])(
    "lets tokens:write author the automated action %s",
    (action) => {
      expect(permissionForWorkflowAction(action)).toBe("tokens:write");
      expect(() => assertWorkflowActionPermitted(contextWith(MEMBER), action)).not.toThrow();
    }
  );

  // The direct routes for these all require tokens:admin. A rule is the same operation
  // one hop removed, so it must clear the same bar.
  it.each(["pause", "unpause", "freeze", "unfreeze"])(
    "requires tokens:admin for the sensitive action %s",
    (action) => {
      expect(permissionForWorkflowAction(action)).toBe("tokens:admin");
      expect(() => assertWorkflowActionPermitted(contextWith(MEMBER), action)).toThrow();
      expect(() => assertWorkflowActionPermitted(contextWith(ADMIN), action)).not.toThrow();
    }
  );

  it.each(["mint", "burn", "seize", "force_burn"])(
    "requires tokens:admin for the irreversible action %s",
    (action) => {
      expect(permissionForWorkflowAction(action)).toBe("tokens:admin");
      expect(() => assertWorkflowActionPermitted(contextWith(MEMBER), action)).toThrow();
      expect(() => assertWorkflowActionPermitted(contextWith(ADMIN), action)).not.toThrow();
    }
  );

  // The regression this whole guard exists for: a plain member is 403'd on
  // POST /tokens/:id/seize, so authoring or approving a seize rule must fail too.
  it("refuses a seize rule to a tokens:write-only principal", () => {
    expect(() => assertWorkflowActionPermitted(contextWith(MEMBER), "seize")).toThrow(
      /tokens:admin/
    );
  });

  it("treats an unknown action as privileged rather than open", () => {
    expect(permissionForWorkflowAction("constructor")).toBe("tokens:admin");
    expect(permissionForWorkflowAction("not_a_real_action")).toBe("tokens:admin");
    expect(() => assertWorkflowActionPermitted(contextWith(MEMBER), "toString")).toThrow();
  });

  it("honors the wildcard permission", () => {
    expect(() => assertWorkflowActionPermitted(contextWith(["*"]), "seize")).not.toThrow();
  });
});
