import type { FigFonts } from "./make-fig";

export const FIGURE_WORDS = [
  "opsWallet",
  "pay",
  "send",
  "received",
  "bankUsd",
  "paidOut",
  "paymentRequest",
  "processed",
  "confirmed",
  "finalized",
  "schedule",
  "howOften",
  "monthly",
  "startsOn",
  "nextRun",
  "agentWallet",
  "api",
  "perCall",
  "callsPaid",
  "wallet",
  "depositReceived",
] as const;

export type FigureWord = (typeof FIGURE_WORDS)[number];

/** The words drawn inside the figures, from the catalog; names, amounts and addresses are data. */
export type FigureCopy = {
  words: Record<FigureWord, string>;
  paidTo: (address: string) => string;
  paidCount: (paid: number, total: number) => string;
  /** A figure in the reader's locale, with exactly `fractionDigits` decimals. */
  number: (value: number, fractionDigits?: number) => string;
  /** The first of a month (0 = January) as a short date in the reader's locale. */
  monthStart: (month: number) => string;
};

export type SceneInput = {
  fonts: FigFonts;
  /** The figure's accessible description. */
  label: string;
  copy: FigureCopy;
};
