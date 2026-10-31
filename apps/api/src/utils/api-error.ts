import type { Response } from 'express';

export type ApiErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
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
  // A body over the parser's limit. Without its own code it fell through to
  // INTERNAL, which told a caller that sent too much that the service had failed.
  413: 'PAYLOAD_TOO_LARGE',
  // body-parser's refusal of a charset or content encoding it cannot read. The
  // caller's request is wrong, so it is an invalid request, not our failure.
  415: 'INVALID_REQUEST',
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
