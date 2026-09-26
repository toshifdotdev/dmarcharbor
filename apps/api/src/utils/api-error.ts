import type { Response } from 'express';

export type ApiErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

const statusToCode: Record<number, ApiErrorCode> = {
  400: 'INVALID_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
};

export function codeForStatus(status: number): ApiErrorCode {
  return statusToCode[status] ?? 'INTERNAL';
}

export function errorBody(status: number, message: string, extra?: Record<string, unknown>): ApiErrorBody {
  return {
    error: {
      code: codeForStatus(status),
      message,
      ...extra,
    },
  };
}

export function sendError(
  response: Response,
  status: number,
  message: string,
  extra?: Record<string, unknown>,
): void {
  response.status(status).json(errorBody(status, message, extra));
}
