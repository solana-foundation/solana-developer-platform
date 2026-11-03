import { TokenPage } from "./token-page";

interface TokenManagementPageProps {
  params: Promise<{
    tokenId: string;
  }>;
}

/**
 * One token's management page.
 *
 * @param props - The route params, carrying the token to read.
 * @returns The token's page.
 */
export default async function TokenManagementPage({ params }: TokenManagementPageProps) {
  return TokenPage({ params });
}
