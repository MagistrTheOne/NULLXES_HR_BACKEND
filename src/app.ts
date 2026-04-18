import express, { type Request, type Response } from "express";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { logger } from "./logging/logger";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { requestIdMiddleware } from "./middleware/requestId";
import { createInterviewsRouter } from "./routes/interviews.routes";
import { createJobAiRouter } from "./routes/jobai.routes";
import { createTzAliasRouter } from "./routes/tzAlias.routes";
import { createMeetingRouter } from "./routes/meeting.routes";
import { createRealtimeRouter } from "./routes/realtime.routes";
import { InMemoryInterviewStore } from "./services/interviewStore";
import { InterviewSyncService } from "./services/interviewSyncService";
import { JobAiClient } from "./services/jobaiClient";
import { MeetingOrchestrator } from "./services/meetingOrchestrator";
import { MeetingStateMachine } from "./services/meetingStateMachine";
import { InMemoryMeetingStore } from "./services/meetingStore";
import { OpenAIRealtimeClient } from "./services/openaiRealtimeClient";
import { PostMeetingProcessor } from "./services/postMeetingProcessor";
import { InMemorySessionStore } from "./services/sessionStore";
import { WebhookDispatcher } from "./services/webhookDispatcher";
import { WebhookOutbox } from "./services/webhookOutbox";

export interface AppContext {
  app: express.Express;
  sessionStore: InMemorySessionStore;
  webhookDispatcher: WebhookDispatcher;
  postMeetingProcessor: PostMeetingProcessor;
}

export function createApp(): AppContext {
  const app = express();
  const sessionStore = new InMemorySessionStore(
    env.SESSION_IDLE_TIMEOUT_MS,
    env.SESSION_SWEEP_INTERVAL_MS
  );
  const openAIClient = new OpenAIRealtimeClient();
  const jobAiClient = new JobAiClient();
  const interviewStore = new InMemoryInterviewStore();
  const interviewService = new InterviewSyncService(jobAiClient, interviewStore);
  const meetingStore = new InMemoryMeetingStore();
  const meetingStateMachine = new MeetingStateMachine();
  const webhookOutbox = new WebhookOutbox();
  const postMeetingProcessor = new PostMeetingProcessor(webhookOutbox);
  const webhookDispatcher = new WebhookDispatcher(webhookOutbox);
  const meetingOrchestrator = new MeetingOrchestrator(
    meetingStore,
    meetingStateMachine,
    webhookOutbox,
    postMeetingProcessor
  );

  app.disable("x-powered-by");
  app.use(requestIdMiddleware);
  app.use(
    pinoHttp({
      logger,
      customProps: (req) => ({
        requestId: req.requestId
      }),
      serializers: {
        req: (req) => ({
          id: req.id,
          method: req.method,
          url: req.url,
          remoteAddress: req.socket?.remoteAddress,
          remotePort: req.socket?.remotePort
        }),
        res: (res) => ({ statusCode: res.statusCode })
      }
    })
  );

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({
      status: "ok",
      uptimeSeconds: process.uptime(),
      timestamp: new Date().toISOString()
    });
  });

  app.use(
    "/realtime",
    createRealtimeRouter({
      openAIClient,
      sessionStore
    })
  );
  app.use("/meetings", createMeetingRouter(meetingOrchestrator));
  app.use("/interviews", createInterviewsRouter(interviewService));
  app.use("/api/v1", createTzAliasRouter(interviewService, jobAiClient));
  app.use("/", createJobAiRouter(interviewService));

  app.get("/ops/webhooks", (_req: Request, res: Response) => {
    res.status(200).json({
      webhookQueue: webhookOutbox.getStats()
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, sessionStore, webhookDispatcher, postMeetingProcessor };
}
