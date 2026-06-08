import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { Errors } from '../utils/errors';

type Source = 'body' | 'query' | 'params';

function zodToFieldErrors(err: ZodError) {
  return err.errors.map((e) => ({
    field: e.path.join('.') || '(root)',
    message: e.message,
  }));
}

/**
 * Zod validation middleware (§2.1). Parses + replaces req[source] with the typed result so
 * downstream handlers get coerced/defaulted values. Failure → 422 VALIDATION_ERROR.
 */
export function validate(schema: ZodSchema, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(Errors.validation('Validation failed', zodToFieldErrors(result.error)));
    }
    // Assign parsed values (query is read-only getter on Express 4 in some versions → guard)
    if (source === 'query') {
      (req as any).validatedQuery = result.data;
    } else {
      (req as any)[source] = result.data;
    }
    next();
  };
}

/** Helper to read validated query (validate() stores it on req.validatedQuery). */
export function vquery<T>(req: Request): T {
  return (req as any).validatedQuery as T;
}
