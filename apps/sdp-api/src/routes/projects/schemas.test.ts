import { describe, expect, it } from "vitest";
import { updateProjectSchema } from "@/routes/projects/schemas";

describe("updateProjectSchema settings.rpcEndpoint", () => {
  const parse = (rpcEndpoint: string) =>
    updateProjectSchema.safeParse({ settings: { rpcProvider: "custom", rpcEndpoint } });

  it("accepts an ordinary https endpoint", () => {
    expect(parse("https://rpc.example.com/abc").success).toBe(true);
  });

  it.each([
    ["http://rpc.example.com/", "plaintext"],
    ["https://169.254.169.254/latest/meta-data", "the metadata address"],
    ["https://127.0.0.1:8899/", "loopback"],
    ["https://10.0.0.5/", "a private range"],
    ["https://[::1]/", "IPv6 loopback"],
    ["https://vault.internal/", "an internal name"],
    ["https://user:pass@rpc.example.com/", "embedded credentials"],
  ])("refuses %s (%s)", (endpoint) => {
    expect(parse(endpoint).success).toBe(false);
  });

  it("leaves an update without settings untouched", () => {
    expect(updateProjectSchema.safeParse({ name: "Payments" }).success).toBe(true);
  });
});
