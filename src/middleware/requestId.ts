import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestIdHeader = req.header("x-request-id");
  const requestId = requestIdHeader && requestIdHeader.length > 0 ? requestIdHeader : randomUUID();

  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);

  next();
}
