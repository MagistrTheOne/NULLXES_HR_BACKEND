import type { NextFunction, Request, Response } from "express";
import { logger } from "../logging/logger";

export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: "NotFound",
    message: `Route not found: ${req.method} ${req.path}`,
    requestId: req.requestId
  });
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  const httpError = error instanceof HttpError ? error : undefined;
  const statusCode = httpError?.statusCode ?? 500;
  const message = httpError?.message ?? "Internal server error";

  logger.error(
    {
      err: error,
      requestId: req.requestId,
      statusCode
    },
    "request failed"
  );

  res.status(statusCode).json({
    error: statusCode >= 500 ? "InternalError" : "RequestError",
    message,
    requestId: req.requestId,
    details: statusCode < 500 ? httpError?.details : undefined
  });
}
