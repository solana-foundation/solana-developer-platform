import {
  compareDecimalAmounts as comparePaymentAmounts,
  sumDecimalAmounts,
} from "@sdp/payments/decimal";
import { SdpPaymentsError } from "@sdp/payments/errors";
import {
  AmountError,
  compareDecimalAmounts,
  decimalScale,
  formatDecimalAmount,
  parseDecimalAmount,
  parseTokenAmount,
} from "@sdp/solana/amount";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertPositivePaymentAmount } from "@/services/payment-operation.service";
import { propertyParameters } from "@/test/helpers/property";

/**
 * Property tests (STRIDE P5.4) for the decimal/base-unit conversions every
 * payment amount passes through: request strings to u64 base units
 * (`parseTokenAmount`, behind each mint's `toBaseUnits`), base units back to
 * strings (`formatDecimalAmount`), and the batch totals (`sumDecimalAmounts`).
 * Expected values come from a string model built with bigint digit
 * arithmetic, never from the code under test or a float.
 */

const U64_MAX = 2n ** 64n - 1n;

// A mint's decimals is a u8; past 24 digits nothing changes but the padding.
const decimalsArb = fc.integer({ min: 0, max: 24 });
// Every decimals a mint can declare, for the comparisons that must hold at any scale.
const mintDecimalsArb = fc.oneof(decimalsArb, fc.integer({ min: 0, max: 255 }));
const u64Arb = fc.oneof(
  fc.bigInt({ min: 0n, max: U64_MAX }),
  fc.constantFrom(0n, 1n, U64_MAX - 1n, U64_MAX)
);

interface Spelling {
  extraLeadingZeros: number;
  extraTrailingZeros: number;
  trimTrailingZeros: boolean;
  bareFraction: boolean;
  bareWhole: boolean;
  padding: string;
}

const spellingArb: fc.Arbitrary<Spelling> = fc.record({
  extraLeadingZeros: fc.integer({ min: 0, max: 3 }),
  extraTrailingZeros: fc.integer({ min: 0, max: 3 }),
  trimTrailingZeros: fc.boolean(),
  bareFraction: fc.boolean(),
  bareWhole: fc.boolean(),
  padding: fc.constantFrom("", " ", "\t", "\n "),
});

/**
 * Spells `raw` base units at `decimals` the ways a client may: leading and
 * trailing zeros (never past `decimals` fractional digits), ".5" and "5.",
 * and surrounding whitespace.
 */
function spell(raw: bigint, decimals: number, spelling: Spelling): string {
  const digits = raw.toString().padStart(decimals + 1, "0");
  let whole = digits.slice(0, digits.length - decimals);
  let fraction = digits.slice(digits.length - decimals);
  if (spelling.trimTrailingZeros) fraction = fraction.replace(/0+$/, "");
  fraction = fraction.padEnd(
    Math.min(decimals, fraction.length + spelling.extraTrailingZeros),
    "0"
  );
  whole = "0".repeat(spelling.extraLeadingZeros) + whole;
  if (spelling.bareFraction && /^0+$/.test(whole) && fraction.length > 0) whole = "";
  const text =
    fraction.length > 0 ? `${whole}.${fraction}` : spelling.bareWhole ? `${whole}.` : whole;
  return `${spelling.padding}${text}${spelling.padding}`;
}

/** A canonical amount string's base units at `scale`, in unbounded bigint. */
function scaled(text: string, scale: number): bigint {
  const [whole, fraction = ""] = text.split(".");
  return BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
}

/** The canonical spelling `formatDecimalAmount` must produce. */
function canonical(raw: bigint, decimals: number): string {
  const digits = raw.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

describe("payment amount conversions (property)", () => {
  it("parses every spelling of a u64 amount to exactly its base units", () => {
    fc.assert(
      fc.property(u64Arb, decimalsArb, spellingArb, (raw, decimals, spelling) => {
        expect(parseTokenAmount(spell(raw, decimals, spelling), decimals)).toBe(raw);
      }),
      propertyParameters()
    );
  });

  it("round-trips base units through the canonical string", () => {
    fc.assert(
      fc.property(u64Arb, decimalsArb, (raw, decimals) => {
        const text = formatDecimalAmount(raw, decimals);
        expect(text).toBe(canonical(raw, decimals));
        expect(parseTokenAmount(text, decimals)).toBe(raw);
      }),
      propertyParameters()
    );
  });

  it("refuses an amount above u64 rather than wrapping or clamping it", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: U64_MAX + 1n, max: 2n ** 200n }),
        decimalsArb,
        spellingArb,
        (raw, decimals, spelling) => {
          const text = spell(raw, decimals, spelling);
          expect(() => parseTokenAmount(text, decimals)).toThrow(AmountError);
          // The 256-bit parser still reads it exactly, so the refusal is the u64 bound.
          expect(parseDecimalAmount(text, decimals)).toBe(raw);
        }
      ),
      propertyParameters()
    );
  });

  it("refuses precision beyond the mint's decimals rather than rounding", () => {
    fc.assert(
      fc.property(
        u64Arb,
        decimalsArb,
        fc.integer({ min: 1, max: 9 }),
        fc.integer({ min: 1, max: 4 }),
        (raw, decimals, lastDigit, excess) => {
          // `excess` more fractional digits than the mint has, ending in a non-zero digit.
          const base = spell(raw, decimals, {
            extraLeadingZeros: 0,
            extraTrailingZeros: 0,
            trimTrailingZeros: false,
            bareFraction: false,
            bareWhole: false,
            padding: "",
          });
          const text = `${base}${decimals === 0 ? "." : ""}${"0".repeat(excess - 1)}${lastDigit}`;
          expect(() => parseTokenAmount(text, decimals)).toThrow(AmountError);
        }
      ),
      propertyParameters()
    );
  });

  it("refuses signs, exponents, separators and non-ASCII digits anywhere in the amount", () => {
    const intruder = fc.constantFrom(
      "-",
      "+",
      "e",
      "E",
      ",",
      "_",
      "x",
      "٣",
      "０",
      "NaN",
      "Infinity"
    );
    fc.assert(
      fc.property(u64Arb, decimalsArb, intruder, fc.nat(), (raw, decimals, inserted, position) => {
        const base = formatDecimalAmount(raw, decimals);
        const at = position % (base.length + 1);
        const text = `${base.slice(0, at)}${inserted}${base.slice(at)}`;
        expect(() => parseTokenAmount(text, decimals)).toThrow(AmountError);
        expect(() => assertPositivePaymentAmount(text)).toThrow("Invalid amount format");
      }),
      propertyParameters()
    );
  });

  it("admits a payment amount as positive exactly when its base units are", () => {
    fc.assert(
      fc.property(u64Arb, decimalsArb, spellingArb, (raw, decimals, spelling) => {
        const text = spell(raw, decimals, spelling);
        if (raw > 0n) {
          expect(parseTokenAmount(assertPositivePaymentAmount(text), decimals)).toBe(raw);
        } else {
          expect(() => assertPositivePaymentAmount(text)).toThrow(
            "Transfer amount must be greater than zero"
          );
        }
      }),
      propertyParameters()
    );
  });

  it("sums batch amounts exactly, in any order", () => {
    fc.assert(
      fc.property(
        decimalsArb,
        fc
          .array(u64Arb, { minLength: 1, maxLength: 200 })
          .chain((raws) =>
            fc.tuple(fc.constant(raws), fc.shuffledSubarray(raws, { minLength: raws.length }))
          ),
        (decimals, [raws, shuffled]) => {
          const expected = raws.reduce((sum, raw) => sum + raw, 0n);
          const total = sumDecimalAmounts(raws.map((raw) => formatDecimalAmount(raw, decimals)));
          expect(parseDecimalAmount(total, decimals)).toBe(expected);
          expect(sumDecimalAmounts(shuffled.map((raw) => formatDecimalAmount(raw, decimals)))).toBe(
            total
          );
        }
      ),
      propertyParameters()
    );
  });

  it("orders amounts at different scales by their exact value", () => {
    fc.assert(
      fc.property(
        u64Arb,
        mintDecimalsArb,
        u64Arb,
        mintDecimalsArb,
        (left, leftDecimals, right, rightDecimals) => {
          // left / 10^ld vs right / 10^rd, cross-multiplied in bigint.
          const difference =
            left * 10n ** BigInt(rightDecimals) - right * 10n ** BigInt(leftDecimals);
          const expected = difference === 0n ? 0 : difference > 0n ? 1 : -1;
          const leftText = formatDecimalAmount(left, leftDecimals);
          const rightText = formatDecimalAmount(right, rightDecimals);
          expect(comparePaymentAmounts(leftText, rightText)).toBe(expected);
          // The 256-bit `@sdp/solana` comparison covers every scale a u64 fits at.
          if (Math.max(leftDecimals, rightDecimals) <= 57) {
            expect(compareDecimalAmounts(leftText, rightText)).toBe(expected);
          }
        }
      ),
      propertyParameters()
    );
  });

  it("refuses provider arithmetic past 128 bits as a bad request, never a raw error", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(u64Arb, mintDecimalsArb), { minLength: 1, maxLength: 8 }),
        (entries) => {
          const texts = entries.map(([raw, decimals]) => formatDecimalAmount(raw, decimals));
          const scale = Math.max(...texts.map(decimalScale));
          const exact = texts.reduce((sum, text) => sum + scaled(text, scale), 0n);
          try {
            expect(parseDecimalAmount(sumDecimalAmounts(texts), scale)).toBe(exact);
          } catch (error) {
            expect(error).toBeInstanceOf(SdpPaymentsError);
            expect((error as SdpPaymentsError).statusCode).toBe(400);
            expect(exact).toBeGreaterThan(2n ** 128n - 1n);
          }
        }
      ),
      propertyParameters()
    );
  });
});
