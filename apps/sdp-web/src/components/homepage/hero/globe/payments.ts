/*
 * The payments the globe shows: the cities they leave and land in, and the amounts the tags
 * carry. City names are proper nouns and amounts are figures, so they are data, not copy.
 */
export type City = { lat: number; lon: number; name: string };

export const CITIES: Record<string, City> = {
  fra: { lat: 50.1, lon: 8.7, name: "Frankfurt" },
  sin: { lat: 1.3, lon: 103.8, name: "Singapore" },
  lon: { lat: 51.5, lon: -0.1, name: "London" },
  iad: { lat: 38.9, lon: -77.4, name: "Washington" },
  sfo: { lat: 37.6, lon: -122.4, name: "San Francisco" },
  tyo: { lat: 35.7, lon: 139.7, name: "Tokyo" },
  ams: { lat: 52.3, lon: 4.8, name: "Amsterdam" },
  gru: { lat: -23.4, lon: -46.5, name: "São Paulo" },
  syd: { lat: -33.9, lon: 151.2, name: "Sydney" },
  dxb: { lat: 25.3, lon: 55.4, name: "Dubai" },
  nyc: { lat: 40.7, lon: -74.0, name: "New York" },
  lag: { lat: 6.5, lon: 3.4, name: "Lagos" },
  bom: { lat: 19.1, lon: 72.9, name: "Mumbai" },
  jnb: { lat: -26.2, lon: 28.0, name: "Johannesburg" },
  mex: { lat: 19.4, lon: -99.1, name: "Mexico City" },
  hkg: { lat: 22.3, lon: 114.2, name: "Hong Kong" },
};

export type Amount = { figure: string; currency: string };

export const AMOUNTS: readonly Amount[] = [
  { figure: "12,500.00", currency: "USDC" },
  { figure: "840.00", currency: "USDC" },
  { figure: "1,020,000.00", currency: "USDC" },
  { figure: "96.40", currency: "USDC" },
  { figure: "25,000.00", currency: "USDC" },
  { figure: "3,300.00", currency: "EURC" },
  { figure: "410.00", currency: "USDC" },
  { figure: "78,000.00", currency: "USDC" },
];

/** The words the tags say, from the page's catalog. */
export type GlobeLabels = {
  from: (city: string) => string;
  confirmed: string;
  landed: (city: string) => string;
};
