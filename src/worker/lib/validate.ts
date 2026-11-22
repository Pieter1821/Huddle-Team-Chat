import { zValidator } from '@hono/zod-validator';
import type { ZodType } from 'zod';
import { badRequest } from './errors';

/** Validates a JSON body and answers 400 with the first problem in plain words. */
export const jsonBody = <T extends ZodType>(schema: T) =>
  zValidator('json', schema, (result) => {
    if (!result.success) {
      const issue = result.error.issues[0];
      const field = issue?.path.join('.');
      throw badRequest('invalid_request', field ? `${field}: ${issue?.message}` : 'The request is invalid.');
    }
  });

export const queryParams = <T extends ZodType>(schema: T) =>
  zValidator('query', schema, (result) => {
    if (!result.success) throw badRequest('invalid_request', 'The query parameters are invalid.');
  });
