import { AuthorityType } from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import { updateAuthoritySchema } from "../schemas";
import * as authorityModule from "./authority";

type MappedAuthorityRole = (typeof AuthorityType)[keyof typeof AuthorityType] | "Metadata";

describe("update authority surface", () => {
  it("accepts the confidentialTransfer authority role", () => {
    const parsed = updateAuthoritySchema.safeParse({
      authority: {
        role: "confidentialTransfer",
        newAuthority: "So11111111111111111111111111111111111111112",
      },
    });
    // The retired-signer closure requires the platform to model rotation of the
    // ConfidentialTransferMint authority at all; rejecting the role is the
    // reported finding.
    expect(parsed.success).toBe(true);
  });

  it("still rejects unknown authority roles", () => {
    const parsed = updateAuthoritySchema.safeParse({
      authority: {
        role: "treasurer",
        newAuthority: "So11111111111111111111111111111111111111112",
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("maps the confidentialTransfer role to AuthorityType.ConfidentialTransferMint", () => {
    const mapper = (authorityModule as Record<string, unknown>).mapAuthorityRole as
      | ((role: string) => MappedAuthorityRole)
      | undefined;
    expect(mapper).toBeDefined();
    expect(mapper?.("confidentialTransfer")).toBe(AuthorityType.ConfidentialTransferMint);
    expect(mapper?.("mint")).toBe(AuthorityType.MintTokens);
    expect(mapper?.("freeze")).toBe(AuthorityType.FreezeAccount);
    expect(mapper?.("permanentDelegate")).toBe(AuthorityType.PermanentDelegate);
    expect(mapper?.("metadata")).toBe("Metadata");
  });
});
