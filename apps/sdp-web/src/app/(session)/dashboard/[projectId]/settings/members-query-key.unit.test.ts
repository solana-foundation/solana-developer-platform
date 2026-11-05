import { describe, expect, it } from "vitest";
import { membersQueryKeys } from "./members-query-key";

describe("members query keys", () => {
  it("carries every param into the cache identity", () => {
    expect(membersQueryKeys.memberApiKeys({ memberId: "mem_1" })).toContain("mem_1");
  });
});
