import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("keeps a token text size beside a text colour", () => {
    expect(cn("text-success", "text-body")).toBe("text-success text-body");
  });

  it("keeps a token shadow beside a shadow colour", () => {
    expect(cn("shadow-chip", "shadow-red-500")).toBe("shadow-chip shadow-red-500");
  });

  it("lets a later shadow size replace a token shadow", () => {
    expect(cn("shadow-ring", "shadow-sm")).toBe("shadow-sm");
  });
});
