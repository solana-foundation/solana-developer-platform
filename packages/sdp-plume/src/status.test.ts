import {
  plumeMintStatusSchema,
  plumeRedeemStatusSchema,
  plumeRequest,
} from "@sdp/earn/providers/plume/api";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

describe.each([
  {
    direction: "mint",
    path: "/solana/mint-status/source",
    schema: plumeMintStatusSchema,
    status: {
      solanaSignature: "source",
      solanaWallet: "owner",
      steps: { solanaMint: { signature: "destination" } },
    },
  },
  {
    direction: "redeem",
    path: "/solana/redeem-status/source",
    schema: plumeRedeemStatusSchema,
    status: {
      solanaBurnSignature: "source",
      solanaWallet: "owner",
      steps: { solanaClaim: { signature: "destination" } },
    },
  },
])("Plume $direction settlement status", ({ path, schema, status }) => {
  // Plume's Core OpenAPI allows null independently on both error members.
  it.each([
    { label: "no error", error: null, recoveryRequired: false },
    {
      label: "nullable error members",
      error: { code: null, message: null },
      recoveryRequired: false,
    },
    {
      label: "error code without a message",
      error: { code: "RELAY_FAILED", message: null },
      recoveryRequired: true,
    },
    {
      label: "populated error",
      error: { code: "RELAY_FAILED", message: "Relay needs recovery" },
      recoveryRequired: true,
    },
  ])("accepts $label without losing delivery identity", async ({ error, recoveryRequired }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: { ...status, error } }));

    await expect(plumeRequest(path, schema)).resolves.toEqual({
      sourceSignature: "source",
      owner: "owner",
      destinationSignature: "destination",
      recoveryRequired,
    });
  });
});
