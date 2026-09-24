/**
 * The sixteen "Solana Developer Platform" interviews on the Solana YouTube
 * channel, by video id; the stills are served at /homepage/builders/<id>.jpg.
 * Partner names are proper nouns and stay untranslated.
 */
export const FILMS = [
  ["ZfUtJgkE5dE", "Fireblocks"],
  ["QGRwG0XdTJs", "Helius"],
  ["VdjsVXMcvrQ", "Alchemy"],
  ["PN7ZoAEpcgo", "Coinbase"],
  ["CQ5uPmKYRJA", "Privy"],
  ["Ksrj8xVGV5I", "Turnkey"],
  ["U9V2nmGMNUw", "BitGo"],
  ["1kWBItQlmyA", "TRM"],
  ["Unca2BqAKNA", "Quicknode"],
  ["V2wQHgMhTaY", "Triton One"],
  ["KgjoIlT3UQs", "MoonPay"],
  ["SR5bj2ALNNA", "Crossmint"],
  ["RhBQgkSND1A", "Para"],
  ["mmEwNkJi7tY", "Range"],
  ["KBUnHxtv1hA", "Modern Treasury"],
  ["eg1joEasU7s", "Dynamic"],
] as const;

export const filmUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

export const SERIES_URL =
  "https://www.youtube.com/@solana/search?query=Solana%20Developer%20Platform";
