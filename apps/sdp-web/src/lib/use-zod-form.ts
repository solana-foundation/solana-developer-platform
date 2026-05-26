"use client";

import { useCallback, useRef, useState } from "react";
import type { z } from "zod";

export type FieldErrors<T> = Partial<Record<keyof T, string>>;

export interface ZodFormApi<TInput, TOutput> {
  values: TInput;
  errors: FieldErrors<TInput>;
  setField: <K extends keyof TInput>(key: K, value: TInput[K]) => void;
  validate: () => { ok: true; data: TOutput } | { ok: false };
  reset: () => void;
}

export function useZodForm<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  initialValues: z.input<TSchema>
): ZodFormApi<z.input<TSchema>, z.output<TSchema>> {
  type TInput = z.input<TSchema>;
  type TOutput = z.output<TSchema>;

  const initialValuesRef = useRef(initialValues);
  const [values, setValues] = useState<TInput>(initialValuesRef.current);
  const [errors, setErrors] = useState<FieldErrors<TInput>>({});

  const setField = useCallback(<K extends keyof TInput>(key: K, value: TInput[K]) => {
    setValues((prev) => ({ ...(prev as object), [key]: value }) as TInput);
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const validate = useCallback(() => {
    const result = schema.safeParse(values);
    if (!result.success) {
      const fieldErrors: FieldErrors<TInput> = {};
      for (const issue of result.error.issues) {
        const key = issue.path[0] as keyof TInput | undefined;
        if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      setErrors(fieldErrors);
      return { ok: false as const };
    }
    setErrors({});
    return { ok: true as const, data: result.data as TOutput };
  }, [values, schema]);

  const reset = useCallback(() => {
    setValues(initialValuesRef.current);
    setErrors({});
  }, []);

  return { values, errors, setField, validate, reset };
}
