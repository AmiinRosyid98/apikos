/** Typed application errors mapping to the §2.2 error code table. */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'TOKEN_EXPIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PLAN_LIMIT_EXCEEDED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface FieldError {
  field: string;
  message: string;
}

export class AppError extends Error {
  readonly httpStatus: number;
  readonly code: ErrorCode;
  readonly errors?: FieldError[];

  constructor(httpStatus: number, code: ErrorCode, message: string, errors?: FieldError[]) {
    super(message);
    this.httpStatus = httpStatus;
    this.code = code;
    this.errors = errors;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export const Errors = {
  validation: (message = 'Validation failed', errors?: FieldError[]) =>
    new AppError(422, 'VALIDATION_ERROR', message, errors),
  unauthenticated: (message = 'Authentication required') =>
    new AppError(401, 'UNAUTHENTICATED', message),
  tokenExpired: (message = 'Access token expired') =>
    new AppError(401, 'TOKEN_EXPIRED', message),
  forbidden: (message = 'You do not have permission to perform this action') =>
    new AppError(403, 'FORBIDDEN', message),
  notFound: (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message),
  conflict: (message = 'Resource conflict') => new AppError(409, 'CONFLICT', message),
  planLimit: (message = 'Subscription plan limit reached') =>
    new AppError(403, 'PLAN_LIMIT_EXCEEDED', message),
  rateLimited: (message = 'Too many requests') => new AppError(429, 'RATE_LIMITED', message),
  internal: (message = 'Internal server error') => new AppError(500, 'INTERNAL_ERROR', message),
};
