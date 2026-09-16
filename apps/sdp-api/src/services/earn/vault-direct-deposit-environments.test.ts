import {
  EARN_PROVIDER_DEPLOYED_CLUSTERS,
  EARN_PROVIDERS,
  isVaultDirectDepositEnabled,
} from "@sdp/types";
import { describe, expect, it } from "vitest";

/**
 * Pins the deployed-cluster map (`@sdp/types/provider-access`): the ONE input
 * to "may this project environment open a NEW vault_direct deposit with this
 * provider". It is DERIVED from each provider's own program or deployment
 * table, so a provider reaches an environment by gaining a deployment on that
 * environment's cluster, never by a hand edit here. Both money-in routes and
 * the dashboard read the same predicate. This test is the diff a reviewer
 * sees when a provider's mainnet posture changes.
 */
describe("EARN_PROVIDER_DEPLOYED_CLUSTERS", () => {
  it("follows each provider's deployment table (PRO-1986)", () => {
    expect(EARN_PROVIDER_DEPLOYED_CLUSTERS).toEqual({
      kamino: ["devnet", "mainnet-beta"],
      veda: ["devnet"],
      upshift: [],
      perena: [],
      jupiter_lend: ["mainnet-beta"],
      ondo: ["mainnet-beta"],
    });
  });

  it("covers every registered provider", () => {
    expect(Object.keys(EARN_PROVIDER_DEPLOYED_CLUSTERS).sort()).toEqual([...EARN_PROVIDERS].sort());
  });

  it("opens a deposit only where the environment's cluster carries a deployment", () => {
    // sandbox is devnet, production is mainnet-beta (CLUSTER_BY_SDP_ENVIRONMENT).
    expect(isVaultDirectDepositEnabled("sandbox", "kamino")).toBe(true);
    expect(isVaultDirectDepositEnabled("production", "kamino")).toBe(true);
    expect(isVaultDirectDepositEnabled("sandbox", "veda")).toBe(true);
    expect(isVaultDirectDepositEnabled("production", "veda")).toBe(false);
    expect(isVaultDirectDepositEnabled("sandbox", "jupiter_lend")).toBe(false);
    expect(isVaultDirectDepositEnabled("production", "jupiter_lend")).toBe(true);
    expect(isVaultDirectDepositEnabled("sandbox", "ondo")).toBe(false);
    expect(isVaultDirectDepositEnabled("production", "ondo")).toBe(true);
    expect(isVaultDirectDepositEnabled("sandbox", "upshift")).toBe(false);
  });

  it("fails closed on an unknown provider or environment", () => {
    expect(isVaultDirectDepositEnabled("production", "ground")).toBe(false);
    expect(isVaultDirectDepositEnabled("staging", "kamino")).toBe(false);
  });
});
