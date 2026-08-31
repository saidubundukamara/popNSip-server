import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

import { isProduction } from '@/config/env';
import {
  AppError,
  InvalidModifierSelectionError,
  ItemUnavailableError,
  NotFoundError,
  ValidationError,
  isAppError,
} from '@/lib/errors';

/** Nothing matched. Hand a 404 to the error handler rather than letting Express render HTML. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`No route for ${req.method} ${req.path}`));
};

/** zod escaping a route guard is a validation failure, not a 500. */
const normalise = (error: unknown): AppError => {
  if (isAppError(error)) return error;

  if (error instanceof ZodError) {
    return new ValidationError(
      'The request did not match what this endpoint expects.',
      error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }

  // Express 5 surfaces a malformed JSON body as a SyntaxError with `status`.
  if (error instanceof SyntaxError && 'body' in error) {
    return new ValidationError('Request body is not valid JSON.');
  }

  return new (class extends AppError {
    readonly statusCode = 500;
    readonly code = 'INTERNAL_ERROR';
    override readonly isOperational = false;
  })(isProduction ? 'Something went wrong on our side.' : String(error), undefined, { cause: error });
};

/**
 * The one place an error becomes an HTTP response. Full detail goes to the
 * log with the request id; the client gets a sanitised message and that same
 * id, so a customer can quote it and we can find the exact failure.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const appError = normalise(error);
  const log = req.log ?? console;

  const context = {
    err: error,
    statusCode: appError.statusCode,
    code: appError.code,
    method: req.method,
    path: req.path,
    details: appError.details,
  };

  if (appError.statusCode >= 500 || !appError.isOperational) {
    log.error(context, appError.message);
  } else {
    log.warn(context, appError.message);
  }

  res.status(appError.statusCode).json({
    error: {
      code: appError.code,
      message: appError.message,
      requestId: req.id,
      // These three carry the detail a client needs to correct the request:
      // which field, which item, which group. All of it describes what the
      // caller sent, so none of it leaks anything they did not already know.
      ...(appError instanceof ValidationError && appError.issues.length > 0 ? { issues: appError.issues } : {}),
      ...(appError instanceof ItemUnavailableError ? { unavailable: appError.unavailable } : {}),
      ...(appError instanceof InvalidModifierSelectionError ? { problems: appError.problems } : {}),
    },
  });
};
