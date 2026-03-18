import fs from "node:fs";
import path from "node:path";

export interface IssuanceFixtureWallet {
  id: string;
  walletId: string;
  publicKey: string;
  label: string | null;
}

export interface IssuanceFixtureToken {
  id: string;
  name: string;
  symbol: string;
  mintAddress: string | null;
  status: string;
}

export interface IssuanceFixtures {
  organization: {
    clerkOrgId: string;
    localOrgId: string;
    slug: string;
    name: string;
  };
  projectId: string;
  wallets: {
    treasury: IssuanceFixtureWallet;
    delegated: IssuanceFixtureWallet;
  };
  tokens: {
    pending: IssuanceFixtureToken;
    allowlisted: IssuanceFixtureToken;
    open: IssuanceFixtureToken;
  };
  addresses: {
    allowlistWallet: string;
    freezeWallet: string;
  };
}

export const issuanceFixturesPath = path.join(__dirname, "../.fixtures/issuance.json");

export function writeIssuanceFixtures(fixtures: IssuanceFixtures): void {
  fs.mkdirSync(path.dirname(issuanceFixturesPath), { recursive: true });
  fs.writeFileSync(issuanceFixturesPath, JSON.stringify(fixtures, null, 2));
}

export function readIssuanceFixtures(): IssuanceFixtures {
  return JSON.parse(fs.readFileSync(issuanceFixturesPath, "utf8")) as IssuanceFixtures;
}

export function clearIssuanceFixtures(): void {
  fs.rmSync(issuanceFixturesPath, { force: true });
}
