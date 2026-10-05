import { HttpException, HttpStatus } from '@nestjs/common';

export class ApiError extends HttpException {
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super({ statusCode: status, error: code, message, ...details }, status);
  }
}

export const notFound = (what: string) =>
  new ApiError(HttpStatus.NOT_FOUND, 'not_found', `${what} not found`);
export const forbidden = (message = 'insufficient permissions') =>
  new ApiError(HttpStatus.FORBIDDEN, 'forbidden', message);
export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new ApiError(HttpStatus.BAD_REQUEST, 'bad_request', message, details);
export const conflict = (message: string, details?: Record<string, unknown>) =>
  new ApiError(HttpStatus.CONFLICT, 'conflict', message, details);
export const unauthorized = (message = 'authentication required') =>
  new ApiError(HttpStatus.UNAUTHORIZED, 'unauthorized', message);
export const unprocessable = (message: string, details?: Record<string, unknown>) =>
  new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'unprocessable', message, details);
