import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ErrorRequestHandler, Request, Response } from 'express';

import { ForbiddenError, UnauthorizedError, ValidationError } from '@/lib/errors';
import { errorHandler } from '@/middleware/error_handler';

/**
 * The one place every failure becomes an HTTP response, and until now the one
 * piece of the request path with no test at all — a refactor that stopped it
 * calling `res.json` left the whole suite green while every error response
 * hung. These assert the two things it owes a caller: a status and a body,
 * always, and a log level that matches how much the failure deserves
 * attention.
 */

type Logged = { level: string; context: Record<string, unknown>; message: string };

function invoke(error: unknown) {
  const logged: Logged[] = [];
  const record = (level: string) => (context: Record<string, unknown>, message: string) =>
    logged.push({ level, context, message });

  let status: number | undefined;
  let body: { error?: { code?: string; message?: string; requestId?: string } } | undefined;

  const req = {
    id: 'req-1',
    method: 'GET',
    path: '/api/thing',
    log: { info: record('info'), warn: record('warn'), error: record('error') },
  } as unknown as Request;

  const res = {
    headersSent: false,
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = payload as typeof body;
      return this;
    },
  } as unknown as Response;

  (errorHandler as ErrorRequestHandler)(error, req, res, () => undefined);
  return { status, body, logged };
}

describe('error handler', () => {
  it('always answers, whatever the failure', () => {
    for (const error of [
      new UnauthorizedError(),
      new ForbiddenError(),
      new ValidationError('Nope'),
      new Error('something unexpected'),
    ]) {
      const { status, body } = invoke(error);
      assert.ok(status !== undefined, `${error.name} produced no status`);
      assert.ok(body?.error?.code, `${error.name} produced no body`);
      assert.equal(body?.error?.requestId, 'req-1');
    }
  });

  it('treats "nobody is signed in" as information, not a warning', () => {
    const { status, logged } = invoke(new UnauthorizedError());
    assert.equal(status, 401);
    assert.equal(logged[0]?.level, 'info');
  });

  it('still warns when someone signed in reaches for what they may not have', () => {
    const { status, logged } = invoke(new ForbiddenError());
    assert.equal(status, 403);
    assert.equal(logged[0]?.level, 'warn');
  });

  it('keeps the stack for the failures where it explains something', () => {
    const unexpected = invoke(new Error('boom'));
    assert.equal(unexpected.status, 500);
    assert.equal(unexpected.logged[0]?.level, 'error');
    assert.ok(unexpected.logged[0]?.context.err, 'a 500 must log the underlying error');

    // ...and drops it where it would only be router frames.
    const expected = invoke(new ValidationError('Nope'));
    assert.equal(expected.logged[0]?.level, 'warn');
    assert.equal(expected.logged[0]?.context.err, undefined);
  });

  it('hands the error onward once a response has already begun', () => {
    let passedOn: unknown;
    const res = { headersSent: true } as unknown as Response;
    const error = new UnauthorizedError();
    (errorHandler as ErrorRequestHandler)(
      error,
      { id: 'r', method: 'GET', path: '/x' } as unknown as Request,
      res,
      (value) => {
        passedOn = value;
      },
    );
    assert.equal(passedOn, error);
  });
});
