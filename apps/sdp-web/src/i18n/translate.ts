export type TranslationValues = Record<string, string | number>;

export type LocalizedMessages<TValue> = {
  [TKey in keyof TValue]?: TValue[TKey] extends string ? string : LocalizedMessages<TValue[TKey]>;
};

export type MessageKeyFor<TValue> = TValue extends string
  ? ""
  : {
      [TKey in Extract<keyof TValue, string>]: TValue[TKey] extends string
        ? TKey
        : `${TKey}.${MessageKeyFor<TValue[TKey]>}`;
    }[Extract<keyof TValue, string>];

export function translate<TMessages>(
  messages: TMessages,
  key: MessageKeyFor<TMessages> & string,
  values?: TranslationValues
): string {
  const message = key.split(".").reduce<unknown>((value, segment) => {
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)[segment]
      : undefined;
  }, messages);

  if (typeof message !== "string") {
    throw new Error(`Missing translation for ${key}`);
  }

  return message.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = values?.[name];
    if (value === undefined) {
      throw new Error(`Missing interpolation value ${name} for ${key}`);
    }
    return String(value);
  });
}

export function mergeLocalizedMessages<TValue>(
  fallback: TValue,
  localized: LocalizedMessages<TValue> | undefined
): TValue {
  return mergeLocalizedValue(fallback, localized) as TValue;
}

export function mergeLocalizedMessagesWithEmbeddedYieldBrand<TValue>(
  fallback: TValue,
  localized: LocalizedMessages<TValue> | undefined
): TValue {
  // Temporary bridge: remove this variant after the translation release PR
  // replaces legacy Earn brand references in every localized catalog.
  return mergeLocalizedValue(fallback, localized, true) as TValue;
}

function mergeLocalizedValue(
  fallback: unknown,
  localized: unknown,
  preserveEmbeddedYieldBrand = false
): unknown {
  if (typeof fallback === "string") {
    const resolved = typeof localized === "string" ? localized : fallback;
    return preserveEmbeddedYieldBrand && fallback.includes("Embedded Yield")
      ? resolved.replace(/\bEarn\b/g, "Embedded Yield")
      : resolved;
  }
  if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) {
    return fallback;
  }

  const localizedRecord =
    localized && typeof localized === "object" && !Array.isArray(localized)
      ? (localized as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    Object.entries(fallback).map(([key, fallbackValue]) => [
      key,
      mergeLocalizedValue(fallbackValue, localizedRecord[key], preserveEmbeddedYieldBrand),
    ])
  );
}
