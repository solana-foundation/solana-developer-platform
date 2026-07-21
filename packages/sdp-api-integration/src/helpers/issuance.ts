import { expect } from "vitest";
import type { MintApiResponse, TokenApiResponse } from "./api-types";
import type { requestWithApiKey } from "./integration";

type IntegrationRequest = ReturnType<typeof requestWithApiKey>;

export const TEST_WALLETS = {
  // biome-ignore lint/security/noSecrets: Test Solana address.
  wallet1: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
  // biome-ignore lint/security/noSecrets: Test Solana address.
  wallet2: "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv",
};

/**
 * Create a stablecoin-template token and return its id.
 */
export async function createStablecoin(
  request: IntegrationRequest,
  name: string,
  symbol: string
): Promise<string> {
  const createRes = await request("/v1/issuance/tokens", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      symbol,
      template: "stablecoin",
      decimals: 6,
      isMintable: true,
      isFreezable: true,
    }),
  });
  expect(createRes.status).toBe(201);

  const created = (await createRes.json()) as TokenApiResponse;
  return created.data.token.id;
}

/**
 * Create a stablecoin-template token, deploy it on-chain, and return its id.
 */
export async function createAndDeployStablecoin(
  request: IntegrationRequest,
  name: string,
  symbol: string
): Promise<string> {
  const tokenId = await createStablecoin(request, name, symbol);
  const deployRes = await request(`/v1/issuance/tokens/${tokenId}/deploy`, {
    method: "POST",
  });
  expect(deployRes.status).toBe(200);

  return tokenId;
}

/**
 * Mint to a destination wallet, asserting the transaction confirms, and
 * return the destination token account.
 */
export async function mintToWallet(
  request: IntegrationRequest,
  tokenId: string,
  destination: string,
  amount: string
): Promise<string> {
  const mintRes = await request(`/v1/issuance/tokens/${tokenId}/mint`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mint: {
        destination,
        amount,
      },
    }),
  });

  expect(mintRes.status).toBe(200);
  const mintBody = (await mintRes.json()) as MintApiResponse;
  expect(mintBody.data.transaction.status).toBe("confirmed");
  expect(mintBody.data.tokenAccount).toBeTruthy();
  return mintBody.data.tokenAccount;
}
