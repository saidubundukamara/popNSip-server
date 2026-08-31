/**
 * The error hierarchy services throw. One terminal Express middleware
 * (`middleware/error_handler.ts`) turns these into status codes and response
 * bodies — no route ever builds an error response by hand.
 *
 * `clientMessage` is what the customer sees. Anything sensitive stays in
 * `details`, which is logged server-side and never serialised to the client.
 */

export type ErrorDetails = Record<string, unknown>;

export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;

  /** Expected failures (400s) are operational; bugs are not. */
  readonly isOperational: boolean = true;

  /** Server-side only. Never sent to the client. */
  readonly details: ErrorDetails | undefined;

  constructor(message: string, details?: ErrorDetails, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class BadRequestError extends AppError {
  readonly statusCode = 400;
  readonly code = 'BAD_REQUEST';
}

export class ValidationError extends AppError {
  readonly statusCode = 422;
  readonly code = 'VALIDATION_FAILED';

  /** Field-level issues, safe to return: they describe the request the client sent. */
  readonly issues: { path: string; message: string }[];

  constructor(message: string, issues: { path: string; message: string }[] = [], details?: ErrorDetails) {
    super(message, details);
    this.issues = issues;
  }
}

export class UnauthorizedError extends AppError {
  readonly statusCode = 401;
  readonly code = 'UNAUTHORIZED';

  constructor(message = 'Authentication required.', details?: ErrorDetails) {
    super(message, details);
  }
}

export class ForbiddenError extends AppError {
  readonly statusCode = 403;
  readonly code = 'FORBIDDEN';

  constructor(message = 'You do not have permission to do that.', details?: ErrorDetails) {
    super(message, details);
  }
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND';

  constructor(message = 'Not found.', details?: ErrorDetails) {
    super(message, details);
  }
}

export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = 'CONFLICT';
}

export class TooManyRequestsError extends AppError {
  readonly statusCode = 429;
  readonly code = 'TOO_MANY_REQUESTS';

  constructor(message = 'Too many requests. Please slow down.', details?: ErrorDetails) {
    super(message, details);
  }
}

/** An upstream (Monime, Whapi, Cloudinary) failed us. */
export class UpstreamError extends AppError {
  readonly statusCode = 502;
  readonly code = 'UPSTREAM_FAILED';

  constructor(
    readonly provider: string,
    message = 'A service we depend on is unavailable.',
    details?: ErrorDetails,
    options?: { cause?: unknown },
  ) {
    super(message, details, options);
  }
}

/** A bug, not a bad request. Reported to the client as a bare 500. */
export class InternalError extends AppError {
  readonly statusCode = 500;
  readonly code = 'INTERNAL_ERROR';
  override readonly isOperational = false;

  constructor(message = 'Something went wrong on our side.', details?: ErrorDetails, options?: { cause?: unknown }) {
    super(message, details, options);
  }
}

/**
 * The cart referenced something that is no longer orderable. Carried as its own
 * type because the storefront, the POS and the WhatsApp bot all need to name
 * the offending lines back to the customer (FR-MENU-5).
 */
export class ItemUnavailableError extends AppError {
  readonly statusCode = 409;
  readonly code = 'ITEM_UNAVAILABLE';

  constructor(
    readonly unavailable: { menuItemId: string; name: string; reason: string }[],
    message = 'Some items are no longer available.',
  ) {
    super(message);
  }
}

/** A modifier group's minSelect/maxSelect was not satisfied (FR-MENU-4). */
export class InvalidModifierSelectionError extends AppError {
  readonly statusCode = 422;
  readonly code = 'INVALID_MODIFIER_SELECTION';

  constructor(
    readonly problems: { groupId: string; groupName: string; message: string }[],
    message = 'Some choices are missing or invalid.',
  ) {
    super(message);
  }
}

/** A status change the state machine does not allow (PRD §7.2). */
export class IllegalTransitionError extends AppError {
  readonly statusCode = 409;
  readonly code = 'ILLEGAL_TRANSITION';

  constructor(
    readonly from: string,
    readonly to: string,
    message = `An order cannot go from ${from} to ${to}.`,
  ) {
    super(message, { from, to });
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;
