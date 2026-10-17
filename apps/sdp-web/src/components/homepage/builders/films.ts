/**
 * The sixteen "Solana Developer Platform: …" interviews on the Solana YouTube channel, by video
 * id, in the order the ring lays them out (two rows of eight). The names are the teams
 * interviewed: proper nouns, not copy. The stills are in `public/homepage/builders/<id>.jpg`.
 */
export const FILMS = [
  { id: "ZfUtJgkE5dE", name: "Fireblocks" },
  { id: "QGRwG0XdTJs", name: "Helius" },
  { id: "VdjsVXMcvrQ", name: "Alchemy" },
  { id: "PN7ZoAEpcgo", name: "Coinbase" },
  { id: "CQ5uPmKYRJA", name: "Privy" },
  { id: "Ksrj8xVGV5I", name: "Turnkey" },
  { id: "U9V2nmGMNUw", name: "BitGo" },
  { id: "1kWBItQlmyA", name: "TRM" },
  { id: "Unca2BqAKNA", name: "Quicknode" },
  { id: "V2wQHgMhTaY", name: "Triton One" },
  { id: "KgjoIlT3UQs", name: "MoonPay" },
  { id: "SR5bj2ALNNA", name: "Crossmint" },
  { id: "RhBQgkSND1A", name: "Para" },
  { id: "mmEwNkJi7tY", name: "Range" },
  { id: "KBUnHxtv1hA", name: "Modern Treasury" },
  { id: "eg1joEasU7s", name: "Dynamic" },
] as const;

export type Film = (typeof FILMS)[number];

export const SERIES_URL =
  "https://www.youtube.com/@solana/search?query=Solana%20Developer%20Platform";

export function filmUrl(id: string) {
  return `https://www.youtube.com/watch?v=${id}`;
}

export function filmStill(id: string) {
  return `/homepage/builders/${id}.jpg`;
}

/** The teams as one sentence, the closing caption's list: "Fireblocks, Helius, … Dynamic." */
export const FILM_NAMES = `${FILMS.map((film) => film.name).join(", ")}.`;
