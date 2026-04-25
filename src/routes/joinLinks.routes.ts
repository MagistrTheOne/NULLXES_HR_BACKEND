import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import { logger } from "../logging/logger";
import {
  joinLinksIssueLimiter,
  joinLinksResolveLimiter
} from "../middleware/rateLimit";
import {
  JoinTokenError,
  JoinTokenSigner,
  type JoinTokenRole
} from "../services/joinTokenSigner";
import type { JoinTokenStore } from "../services/joinTokenStore";
import {
  ObserverSessionTicketError,
  ObserverSessionTicketSigner
} from "../services/observerSessionTicketSigner";
import type { ObserverSessionTicketStore } from "../services/observerSessionTicketStore";

const issueSchema = z.object({
  ttlMs: z.number().int().positive().max(7 * 24 * 60 * 60 * 1000).optional(),
  displayName: z.string().min(1).max(120).optional()
});

const revokeSchema = z.object({
  jti: z.string().min(8).max(64)
});

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

function parseBody<T>(schema: z.ZodSchema<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, "Invalid request payload", parsed.error.flatten());
  }
  return parsed.data;
}

function parseJobAiId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, "Invalid jobAiId");
  }
  return id;
}

interface JoinLinksDeps {
  signer: JoinTokenSigner;
  store: JoinTokenStore;
  observerTicketSigner: ObserverSessionTicketSigner;
  observerTicketStore: ObserverSessionTicketStore;
  resolveMeetingIdByInterview(jobAiId: number): Promise<string | null>;
}

function buildIssueHandler(role: JoinTokenRole, deps: JoinLinksDeps) {
  return asyncHandler(async (req: Request, res: Response) => {
    const jobAiId = parseJobAiId(req.params.jobAiId);
    const { ttlMs, displayName } = parseBody(issueSchema, req.body ?? {});
    const now = Date.now();
    const exp = now + (ttlMs ?? env.JOIN_TOKEN_DEFAULT_TTL_MS);
    const jti = randomUUID();
    const claims = {
      jobAiId,
      role,
      jti,
      iat: now,
      exp,
      ...(displayName ? { displayName } : {})
    };
    const token = deps.signer.sign(claims);
    const url = `${env.JOIN_TOKEN_FRONTEND_BASE_URL.replace(/\/+$/, "")}/join/${role}/${token}`;
    await deps.store.recordIssued({
      jti,
      jobAiId,
      role,
      issuedAt: now,
      exp,
      ip: req.ip,
      ...(displayName ? { displayName } : {})
    });
    logger.info(
      { requestId: req.requestId, jobAiId, role, jti, exp },
      "join link issued"
    );
    res.status(201).json({ token, url, jti, expiresAt: exp });
  });
}

/**
 * Mounted at /interviews. Adds:
 *   POST /interviews/:jobAiId/links/candidate
 *   POST /interviews/:jobAiId/links/spectator
 *   POST /interviews/:jobAiId/links/revoke
 *   GET  /interviews/:jobAiId/links/audit
 *
 * NOTE: keep the path prefix narrow to avoid colliding with existing
 * /interviews/:id GET handlers in interviews.routes.ts.
 */
export function createJoinLinksIssueRouter(deps: JoinLinksDeps): express.Router {
  const router = express.Router({ mergeParams: true });

  router.post("/:jobAiId/links/candidate", joinLinksIssueLimiter, buildIssueHandler("candidate", deps));
  router.post("/:jobAiId/links/spectator", joinLinksIssueLimiter, buildIssueHandler("spectator", deps));

  router.post(
    "/:jobAiId/links/revoke",
    joinLinksIssueLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const jobAiId = parseJobAiId(req.params.jobAiId);
      const { jti } = parseBody(revokeSchema, req.body ?? {});
      // Conservative revoke window: even if we don't know the original exp here,
      // mark revoked for the longest possible TTL we ever issue. The store will
      // honor it via PX TTL on the revoked key.
      const exp = Date.now() + Math.max(env.JOIN_TOKEN_DEFAULT_TTL_MS, 7 * 24 * 60 * 60 * 1000);
      await deps.store.revoke(jobAiId, jti, exp);
      logger.info({ requestId: req.requestId, jobAiId, jti }, "join link revoked");
      res.status(200).json({ revoked: true, jti });
    })
  );

  router.get(
    "/:jobAiId/links/audit",
    asyncHandler(async (req: Request, res: Response) => {
      const jobAiId = parseJobAiId(req.params.jobAiId);
      const limit = Number(req.query.limit ?? 20);
      const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 20;
      const entries = await deps.store.listAudit(jobAiId, safeLimit);
      res.status(200).json({ entries });
    })
  );

  return router;
}

/**
 * Mounted at /join. Adds:
 *   GET /join/candidate/:token
 *   GET /join/spectator/:token
 *
 * Returns the resolved interview/role context, or 401 (invalid signature),
 * 410 (expired or revoked) so the frontend can redirect or show a friendly error.
 */
export function createJoinPublicRouter(deps: JoinLinksDeps): express.Router {
  const router = express.Router();

  const handler = (expectedRole: JoinTokenRole) =>
    asyncHandler(async (req: Request, res: Response) => {
      const token = req.params.token;
      let claims;
      try {
        claims = deps.signer.verify(token);
      } catch (err) {
        if (err instanceof JoinTokenError) {
          if (err.detail.kind === "expired") {
            res.status(410).json({ error: "expired", expiredAt: err.detail.expiredAtMs });
            return;
          }
          res.status(401).json({ error: "invalid_token", reason: err.detail.kind });
          return;
        }
        throw err;
      }

      if (claims.role !== expectedRole) {
        res.status(401).json({ error: "invalid_token", reason: "role_mismatch" });
        return;
      }

      if (await deps.store.isRevoked(claims.jti)) {
        res.status(410).json({ error: "revoked" });
        return;
      }

      res.status(200).json({
        jobAiId: claims.jobAiId,
        role: claims.role,
        jti: claims.jti,
        ...(claims.displayName ? { displayName: claims.displayName } : {}),
        expiresAt: claims.exp
      });
    });

  router.get("/candidate/:token", joinLinksResolveLimiter, handler("candidate"));
  router.get("/spectator/:token", joinLinksResolveLimiter, handler("spectator"));

  /**
   * Issue short-lived observer session ticket bound to active meeting.
   * POST /join/spectator/:token/session-ticket
   */
  router.post(
    "/spectator/:token/session-ticket",
    joinLinksResolveLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const token = req.params.token;
      let claims;
      try {
        claims = deps.signer.verify(token);
      } catch (err) {
        if (err instanceof JoinTokenError) {
          if (err.detail.kind === "expired") {
            res.status(410).json({ error: "expired", expiredAt: err.detail.expiredAtMs });
            return;
          }
          res.status(401).json({ error: "invalid_token", reason: err.detail.kind });
          return;
        }
        throw err;
      }
      if (claims.role !== "spectator") {
        res.status(401).json({ error: "invalid_token", reason: "role_mismatch" });
        return;
      }
      if (await deps.store.isRevoked(claims.jti)) {
        res.status(410).json({ error: "revoked" });
        return;
      }

      const meetingId = await deps.resolveMeetingIdByInterview(claims.jobAiId);
      if (!meetingId) {
        res.status(409).json({ error: "meeting_not_active" });
        return;
      }

      const now = Date.now();
      const exp = now + env.OBSERVER_SESSION_TICKET_TTL_MS;
      const jti = randomUUID();
      const observerTicket = deps.observerTicketSigner.sign({
        jobAiId: claims.jobAiId,
        role: "spectator",
        meetingId,
        jti,
        iat: now,
        exp
      });

      res.status(201).json({
        observerTicket,
        meetingId,
        jobAiId: claims.jobAiId,
        expiresAt: exp
      });
    })
  );

  /**
   * One-time consume + verify observer session ticket.
   * POST /join/spectator/session-ticket/consume
   * body: { observerTicket: string }
   */
  router.post(
    "/spectator/session-ticket/consume",
    joinLinksResolveLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const observerTicket =
        req.body && typeof req.body === "object" && typeof req.body.observerTicket === "string"
          ? req.body.observerTicket.trim()
          : "";
      if (!observerTicket) {
        throw new HttpError(400, "observerTicket is required");
      }

      let claims;
      try {
        claims = deps.observerTicketSigner.verify(observerTicket);
      } catch (err) {
        if (err instanceof ObserverSessionTicketError) {
          if (err.detail.kind === "expired") {
            res.status(410).json({ error: "observer_ticket_expired", expiredAt: err.detail.expiredAtMs });
            return;
          }
          res.status(401).json({ error: "observer_ticket_invalid", reason: err.detail.kind });
          return;
        }
        throw err;
      }

      const consumed = await deps.observerTicketStore.consumeOnce(claims.jti, claims.exp);
      if (!consumed) {
        res.status(409).json({ error: "observer_ticket_consumed" });
        return;
      }

      res.status(200).json({
        jobAiId: claims.jobAiId,
        meetingId: claims.meetingId,
        role: claims.role,
        jti: claims.jti,
        expiresAt: claims.exp
      });
    })
  );

  return router;
}
