// Mainnet addresses that the surfnet forks, so the form can offer names in place of addresses.

export interface KnownMint {
  symbol: string;
  address: string;
  decimals: number;
}

export const MINTS: KnownMint[] = [
  { symbol: "SOL", address: "11111111111111111111111111111111", decimals: 9 },
  // biome-ignore lint/security/noSecrets: a public mainnet address.
  { symbol: "USDC", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  // biome-ignore lint/security/noSecrets: a public mainnet address.
  { symbol: "USDT", address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
  // biome-ignore lint/security/noSecrets: a public mainnet address.
  { symbol: "wYLDS", address: "8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih", decimals: 6 },
];

/// The first vault takes USDC, the form's default mint.
export const VAULTS = [
  // biome-ignore lint/security/noSecrets: a public mainnet address.
  { name: "Kamino USDC", address: "HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E" },
  // biome-ignore lint/security/noSecrets: a public mainnet address.
  { name: "Jupiter Lend USDT", address: "F7tLdeF2YZZex9MR8HgGggyFiz7UU2UgUube2tmfwNPE" },
  // biome-ignore lint/security/noSecrets: a public mainnet address.
  { name: "Ondo USDY", address: "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6" },
  // biome-ignore lint/security/noSecrets: a public mainnet address.
  { name: "Hastra PRIME", address: "3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7" },
  // biome-ignore lint/security/noSecrets: a public mainnet address.
  { name: "Hastra wYLDS", address: "8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih" },
  // biome-ignore lint/security/noSecrets: a public mainnet address.
  { name: "Test provider nOPAL", address: "GArhnnDj3GYhmQeApKVXaRv4TQFwhPcs3SNF6FXsTeXq" },
];

export const PROGRAMS: Record<string, string> = {
  "11111111111111111111111111111111": "System",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token",
  L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95: "Lighthouse",
  "9sgttDZ2vnzb85HWuQbx8vy6Boga32zpP5QRZ7UtbWpp": "Registry",
  jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9: "Jupiter Lend",
  KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd: "Kamino Vault",
  KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD: "Kamino Lend",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
};

/// The surfnet, as Solana Explorer reaches it from the browser.
const CLUSTER = `cluster=custom&customUrl=${encodeURIComponent("http://localhost:8899")}`;

export function explorerUrl(kind: "tx" | "address", value: string): string {
  return `https://explorer.solana.com/${kind}/${value}?${CLUSTER}`;
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}
