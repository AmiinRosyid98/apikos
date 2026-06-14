import { Request, Response, NextFunction, Router, RequestParamHandler } from 'express';
import { z, ZodSchema, ZodError } from 'zod';
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

// --------------------------------------------------------------------------
// Param validation (BUG-004): malformed path params (e.g. a non-UUID `:id`)
// must return 422 VALIDATION_ERROR with the standard envelope — never reach
// Prisma and throw a 500 (which, in non-prod, leaked the query + source path).
// --------------------------------------------------------------------------

const uuidSchema = z.string().uuid();

/**
 * Path-param names that are expected to be UUIDs across every module. Anything
 * captured under one of these names is validated as a UUID before the handler
 * runs. Non-UUID params (e.g. `:type` on the reports export route) are NOT
 * listed and are validated by their own route schema.
 */
export const UUID_PARAM_NAMES = ['id', 'depId', 'propId', 'roomId', 'userId'] as const;

/**
 * Express `router.param()` callback: validates a single captured param as a UUID,
 * forwarding a 422 VALIDATION_ERROR (standard envelope) when it is malformed.
 */
const uuidParamHandler =
  (paramName: string): RequestParamHandler =>
  (_req, _res, next, value) => {
    const result = uuidSchema.safeParse(value);
    if (!result.success) {
      return next(
        Errors.validation('Validation failed', [
          { field: paramName, message: 'Invalid id (must be a UUID)' },
        ]),
      );
    }
    return next();
  };

/**
 * DRY guard: registers UUID validation for every known id-style param name on a
 * router. Call once per router (and on the top-level protected router for
 * mount-path params like `/properties/:id/rooms`). A well-formed-but-nonexistent
 * UUID passes this guard and is handled as before (→ 404 NOT_FOUND).
 */
export function registerUuidParams(router: Router): Router {
  for (const name of UUID_PARAM_NAMES) {
    router.param(name, uuidParamHandler(name));
  }
  return router;
}

/**
 * Per-route param validation middleware (mirrors the body `validate`). Useful
 * when a route needs a bespoke param schema. Failure → 422 VALIDATION_ERROR.
 */
export function validateParams(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      return next(Errors.validation('Validation failed', zodToFieldErrors(result.error)));
    }
    (req as any).params = result.data;
    next();
  };
}
