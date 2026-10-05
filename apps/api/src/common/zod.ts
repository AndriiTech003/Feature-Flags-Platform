import { Body, Query, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { badRequest } from './errors';

export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw badRequest('validation failed', {
        issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    return result.data;
  }
}

export const ZBody = <T>(schema: ZodType<T>) => Body(new ZodPipe(schema));
export const ZQuery = <T>(schema: ZodType<T>) => Query(new ZodPipe(schema));

export function parseOrThrow<T>(schema: ZodType<T>, value: unknown): T {
  return new ZodPipe(schema).transform(value);
}
