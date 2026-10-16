"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { z } from "zod";

export type FieldErrors<T> = Partial<Record<keyof T, string>>;

export interface ZodFormApi<TInput, TOutput> {
  values: TInput;
  errors: FieldErrors<TInput>;
  setField: <K extends keyof TInput>(key: K, value: TInput[K]) => void;
  /** Sets several fields at once; their errors clear, as with `setField`. */
  setFields: (patch: Partial<TInput>) => void;
  validate: () => { ok: true; data: TOutput } | { ok: false };
  reset: () => void;
}

export function useZodForm<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  initialValues: z.input<TSchema>,
  resolveIssueMessage: (message: string) => string = (message) => message
): ZodFormApi<z.input<TSchema>, z.output<TSchema>> {
  type TInput = z.input<TSchema>;
  type TOutput = z.output<TSchema>;

  const initialValuesRef = useRef(initialValues);
  const [values, setValues] = useState<TInput>(initialValuesRef.current);
  const [errors, setErrors] = useState<FieldErrors<TInput>>({});

  const setField = useCallback(<K extends keyof TInput>(key: K, value: TInput[K]) => {
    // SAFETY: `prev` is the schema's input, an object; spreading it and replacing one of its own
    // keys with a value of that key's type gives the input type back.
    setValues((prev) => ({ ...(prev as object), [key]: value }) as TInput);
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const setFields = useCallback((patch: Partial<TInput>) => {
    // SAFETY: as in `setField`: the schema's input is an object, and the patch holds only values
    // of its own keys' types.
    setValues((prev) => ({ ...(prev as object), ...patch }) as TInput);
    setErrors((prev) => {
      const next = { ...prev };
      // SAFETY: `Object.keys(patch)` lists keys of the patch, which are keys of the input.
      for (const key of Object.keys(patch)) delete next[key as keyof TInput];
      return next;
    });
  }, []);

  const validate = useCallback(() => {
    const result = schema.safeParse(values);
    if (!result.success) {
      const fieldErrors: FieldErrors<TInput> = {};
      for (const issue of result.error.issues) {
        // SAFETY: the issue path of an object schema starts with one of the input's keys.
        const key = issue.path[0] as keyof TInput | undefined;
        if (key && !fieldErrors[key]) fieldErrors[key] = resolveIssueMessage(issue.message);
      }
      setErrors(fieldErrors);
      return { ok: false as const };
    }
    setErrors({});
    // SAFETY: `result.data` is the schema's parsed output.
    return { ok: true as const, data: result.data as TOutput };
  }, [values, schema, resolveIssueMessage]);

  const reset = useCallback(() => {
    setValues(initialValuesRef.current);
    setErrors({});
  }, []);

  return useMemo(
    () => ({ values, errors, setField, setFields, validate, reset }),
    [values, errors, setField, setFields, validate, reset]
  );
}
