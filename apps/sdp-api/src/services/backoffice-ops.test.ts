import { describe, expect, it } from "vitest";
import { parseBackofficeCommand } from "@/services/backoffice-ops";

const OPERATOR = ["--operator", "github:oncall", "--reason", "Customer asked", "--ticket", "HOO-1"];

describe("parseBackofficeCommand", () => {
  it("parses status, reset and set-country for mainnet access", () => {
    expect(
      parseBackofficeCommand(["mainnet-access", "status", "--organization-id", "org_1"])
    ).toEqual({ operation: "status", organizationId: "org_1" });
    expect(
      parseBackofficeCommand(["mainnet-access", "reset", "--organization-id", "org_1", ...OPERATOR])
    ).toEqual({
      operation: "reset",
      organizationId: "org_1",
      operator: "github:oncall",
      reason: "Customer asked",
      ticket: "HOO-1",
    });
    expect(
      parseBackofficeCommand([
        "mainnet-access",
        "set-country",
        "--organization-id",
        "org_1",
        "--country",
        "gb",
        ...OPERATOR,
      ])
    ).toMatchObject({ operation: "set-country", countryCode: "GB" });
  });

  it.each([
    ["an unknown tool", ["organization-control", "status", "--organization-id", "org_1"]],
    ["an unknown action", ["mainnet-access", "approve", "--organization-id", "org_1"]],
    ["a stray argument", ["mainnet-access", "status", "extra", "--organization-id", "org_1"]],
    ["an unknown flag", ["mainnet-access", "status", "--organization-id", "org_1", "--force"]],
    ["a reset without a ticket", ["mainnet-access", "reset", "--organization-id", "org_1"]],
    ["no organization", ["mainnet-access", "status"]],
  ])("refuses %s", (_, argv) => {
    expect(() => parseBackofficeCommand(argv)).toThrow();
  });
});
