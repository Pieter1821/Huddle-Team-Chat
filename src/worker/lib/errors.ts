import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** An expected refusal with a stable code the client can act on. Never carries internals. */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const unauthorized = () => new AppError(401, 'unauthorized', 'Sign in to continue.');
export const forbidden = (message = 'You do not have access to this.') =>
  new AppError(403, 'forbidden', message);
export const notFound = (what = 'That') => new AppError(404, 'not_found', `${what} was not found.`);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const badRequest = (code: string, message: string) => new AppError(400, code, message);
