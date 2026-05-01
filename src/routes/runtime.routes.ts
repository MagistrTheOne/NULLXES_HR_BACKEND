import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler";
import type { RuntimeCommandInput, RuntimeCommandRecord } from "../types/runtime";
import type { RuntimeEventStore } from "../services/runtimeEventStore";
import type { RuntimeLeaseStore } from "../services/runtimeLeaseStore";
import type { RuntimeSnapshotService } from "../services/runtimeSnapshotService";

const commandSchema = z.object({
  type: z.enum([
    "agent.pause",
    "agent.resume",
    "agent.cancel_response",
    "agent.force_next_question",
    "agent.end_interview",
    "observer.reconnect",
    "session.stop"
  ]),
  issuedBy: z.string().min(1).max(120).optional(),
  commandId: z.string().min(1).max(160).optional(),
  payload: z.record(z.unknown()).optional()
});

const eventIngestSchema = z.object({
  type: z.enum([
    "stream.token.issued",
    "realtime.session.event",
    "avatar.event",
    "candidate.admission.acquire",
    "candidate.admission.release",
    "candidate.admission.decision"
  ]),
  sessionId: z.string().min(1).optional(),
  jobAiId: z.number().int().positive().optional(),
  actor: z.string().min(1).max(120).optional(),
  payload: z.record(z.unknown()).optional()
});

const OBSERVER_ALLOWED_COMMANDS = new Set<RuntimeCommandInput["type"]>(["observer.reconnect"]);

function isObserverActor(issuedBy?: string): boolean {
  if (!issuedBy) {
    return false;
  }
  const actor = issuedBy.trim().toLowerCase();
  return actor === "observer_ui" || actor.startsWith("observer:");
}

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: express.NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

export function createRuntimeRouter(deps: {
  snapshots: RuntimeSnapshotService;
  events: RuntimeEventStore;
  leases: RuntimeLeaseStore;
  meetingOrchestrator?: import("../services/meetingOrchestrator").MeetingOrchestrator;
}): express.Router {
  const router = express.Router();

  router.get("/by-interview/:jobAiId", asyncHandler(async (req, res) => {
    const jobAiId = Number(req.params.jobAiId);
    if (!Number.isInteger(jobAiId) || jobAiId <= 0) {
      throw new HttpError(400, "Invalid jobAiId");
    }
    const snapshot = await deps.snapshots.getByInterviewId(jobAiId);
    await deps.events.append({
      type: "runtime.snapshot.requested",
      meetingId: snapshot.meetingId,
      jobAiId,
      actor: "runtime.api",
      payload: { requestId: req.requestId }
    });
    res.status(200).json(snapshot);
  }));

  router.get("/:meetingId", asyncHandler(async (req, res) => {
    const snapshot = await deps.snapshots.getByMeetingId(req.params.meetingId);
    await deps.events.append({
      type: "runtime.snapshot.requested",
      meetingId: req.params.meetingId,
      actor: "runtime.api",
      payload: { requestId: req.requestId }
    });
    res.status(200).json(snapshot);
  }));

  router.get("/:meetingId/events", asyncHandler(async (req, res) => {
    const afterRevisionRaw = Number(req.query.afterRevision ?? 0);
    const afterRevision = Number.isFinite(afterRevisionRaw) ? afterRevisionRaw : 0;
    const events = await deps.events.getEvents(req.params.meetingId, afterRevision);
    res.status(200).json({ events });
  }));

  router.post("/:meetingId/events", asyncHandler(async (req, res) => {
    const parsed = eventIngestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid runtime event payload", parsed.error.flatten());
    }
    const event = await deps.events.append({
      type: parsed.data.type,
      meetingId: req.params.meetingId,
      sessionId: parsed.data.sessionId,
      jobAiId: parsed.data.jobAiId,
      actor: parsed.data.actor ?? "runtime.ingest",
      payload: parsed.data.payload ?? {}
    });
    res.status(202).json({ event });
  }));

  router.post("/:meetingId/commands", asyncHandler(async (req, res) => {
    const parsed = commandSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid runtime command payload", parsed.error.flatten());
    }
    const input = parsed.data as RuntimeCommandInput;
    if (isObserverActor(input.issuedBy) && !OBSERVER_ALLOWED_COMMANDS.has(input.type)) {
      await deps.events.append({
        type: "observer_command_denied",
        meetingId: req.params.meetingId,
        actor: input.issuedBy ?? "observer_ui",
        payload: {
          reason: "observer_readonly",
          attemptedType: input.type,
          allowedTypes: Array.from(OBSERVER_ALLOWED_COMMANDS)
        }
      }).catch(() => undefined);
      throw new HttpError(403, "Observer role is read-only for runtime controls", {
        issuedBy: input.issuedBy,
        attemptedType: input.type,
        allowedTypes: Array.from(OBSERVER_ALLOWED_COMMANDS)
      });
    }
    const owner = input.commandId ?? randomUUID();
    const lease = await deps.leases.acquire(`runtime-command:${req.params.meetingId}`, owner, 5_000);
    await deps.events.append({
      type: lease.acquired ? "runtime.lease.acquired" : "runtime.lease.rejected",
      meetingId: req.params.meetingId,
      actor: input.issuedBy ?? "unknown",
      payload: {
        commandType: input.type,
        commandId: owner,
        currentOwner: lease.currentOwner
      }
    });
    if (!lease.acquired) {
      throw new HttpError(409, "Runtime command lease is held by another actor", lease);
    }

    const event = await deps.events.append({
      type: "runtime.command.requested",
      meetingId: req.params.meetingId,
      actor: input.issuedBy ?? "unknown",
      payload: {
        commandId: owner,
        commandType: input.type,
        payload: input.payload ?? {}
      }
    });
    const command: RuntimeCommandRecord = {
      commandId: owner,
      type: input.type,
      meetingId: req.params.meetingId,
      issuedBy: input.issuedBy ?? "unknown",
      createdAtMs: event.timestampMs,
      ackStatus: "accepted",
      revision: event.revision,
      payload: input.payload ?? {}
    };
    await deps.events.recordCommand(command);
    if (input.type === "agent.force_next_question") {
      deps.meetingOrchestrator?.advanceQuestionIndex(req.params.meetingId, {
        actor: input.issuedBy ?? "unknown",
        reason: "force_next_question",
        sourceId: owner
      });
    }
    await deps.leases.release(`runtime-command:${req.params.meetingId}`, owner);
    res.status(202).json({ command });
  }));

  router.get("/:meetingId/stream", asyncHandler(async (req, res) => {
    const meetingId = req.params.meetingId;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });

    let lastRevision = Number(req.query.afterRevision ?? 0);
    const send = async (): Promise<void> => {
      const snapshot = await deps.snapshots.getByMeetingId(meetingId);
      if (snapshot.revision > lastRevision) {
        lastRevision = snapshot.revision;
        res.write(`event: snapshot\n`);
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      }
    };
    await send();
    const timer = setInterval(() => {
      void send().catch(() => undefined);
    }, 1500);

    req.on("close", () => {
      clearInterval(timer);
    });
  }));

  return router;
}
