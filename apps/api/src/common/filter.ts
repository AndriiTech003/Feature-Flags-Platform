import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { PatchError } from '@ashamrai/flags-contracts';
import type { Response } from 'express';

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) return;
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      response
        .status(exception.getStatus())
        .json(typeof body === 'string' ? { statusCode: exception.getStatus(), message: body } : body);
      return;
    }
    if (exception instanceof PatchError) {
      response.status(422).json({
        statusCode: 422,
        error: 'invalid_instruction',
        message: exception.message,
        index: exception.index,
      });
      return;
    }
    const pg = exception as { code?: string; detail?: string };
    if (pg && pg.code === '23505') {
      response
        .status(409)
        .json({ statusCode: 409, error: 'conflict', message: pg.detail ?? 'already exists' });
      return;
    }
    if (pg && (pg.code === '22P02' || pg.code === '23503')) {
      response
        .status(400)
        .json({ statusCode: 400, error: 'bad_request', message: pg.detail ?? 'invalid reference' });
      return;
    }
    console.error(exception);
    response.status(500).json({ statusCode: 500, error: 'internal', message: 'internal server error' });
  }
}
