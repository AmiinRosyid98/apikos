import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { AppError, Errors } from '../utils/errors';
import { isProd } from '../config/env';

/** §2.1/§2.2 error envelope. Last middleware in the chain. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  let appErr: AppError;

  if (err instanceof AppError) {
    appErr = err;
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    appErr = mapPrismaError(err);
  } else if (err instanceof Prisma.PrismaClientValidationError) {
    appErr = Errors.validation('Invalid query parameters');
  } else {
    appErr = Errors.internal();
    // eslint-disable-next-line no-console
    console.error(`[error] [${req.requestId}]`, err);
  }

  const body: Record<string, unknown> = {
    success: false,
    code: appErr.code,
    message: appErr.message,
  };
  if (appErr.errors && appErr.errors.length) body.errors = appErr.errors;
  if (!isProd && appErr.code === 'INTERNAL_ERROR' && err instanceof Error) {
    body.detail = err.message;
  }

  res.status(appErr.httpStatus).json(body);
}

function mapPrismaError(err: Prisma.PrismaClientKnownRequestError): AppError {
  switch (err.code) {
    case 'P2002': {
      const target = (err.meta?.target as string[] | undefined)?.join(', ');
      return Errors.conflict(
        target ? `Unique constraint violated on: ${target}` : 'Unique constraint violated',
      );
    }
    case 'P2025':
      return Errors.notFound('Resource not found');
    case 'P2003':
      return Errors.conflict('Related record constraint failed');
    default:
      // eslint-disable-next-line no-console
      console.error('[prisma]', err.code, err.message);
      return Errors.internal('Database error');
  }
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({
    success: false,
    code: 'NOT_FOUND',
    message: 'Route not found',
  });
}
