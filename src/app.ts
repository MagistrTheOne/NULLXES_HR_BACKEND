import express, { type Request, type Response } from "express";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { logger } from "./logging/logger";
import { createCorsMiddleware } from "./middleware/cors";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { createReadinessHandler } from "./middleware/health";
import { createMetricsContext } from "./middleware/metrics";
import {
  admissionLimiter,
  jobaiIngestLimiter,
  realtimeSessionLimiter,
  realtimeTokenLimiter
} from "./middleware/rateLimit";
import { requestIdMiddleware } from "./middleware/requestId";
import { createAvatarRouter } from "./routes/avatar.routes";
import { createInterviewsRouter } from "./routes/interviews.routes";
import { createJobAiRouter } from "./routes/jobai.routes";
import {
  createJoinLinksIssueRouter,
  createJoinPublicRouter
} from "./routes/joinLinks.routes";
import { createTzAliasRouter } from "./routes/tzAlias.routes";
import { createMeetingRouter } from "./routes/meeting.routes";
import { createRealtimeRouter } from "./routes/realtime.routes";
import { createRuntimeRouter } from "./routes/runtime.routes";
import { AvatarClient } from "./services/avatarClient";
import { AvatarStateStore } from "./services/avatarStateStore";
import { StreamProvisioner } from "./services/streamProvisioner";
import { StreamRecordingService } from "./services/streamRecordingService";
import { InterviewSyncService } from "./services/interviewSyncService";
import { JobAiClient } from "./services/jobaiClient";
import { JoinTokenSigner } from "./services/joinTokenSigner";
import {
  InMemoryObserverSessionTicketStore,
  RedisObserverSessionTicketStore
} from "./services/observerSessionTicketStore";
import { ObserverSessionTicketSigner } from "./services/observerSessionTicketSigner";
import { MeetingOrchestrator } from "./services/meetingOrchestrator";
import { MeetingStateMachine } from "./services/meetingStateMachine";
import { OpenAIRealtimeClient } from "./services/openaiRealtimeClient";
import { PostMeetingProcessor } from "./services/postMeetingProcessor";
import { RuntimeEventStore } from "./services/runtimeEventStore";
import { RuntimeLeaseStore } from "./services/runtimeLeaseStore";
import { RuntimeSnapshotService } from "./services/runtimeSnapshotService";
import { createStorageBackends, type StorageBackends } from "./services/storageFactory";
import type { InMemorySessionStore } from "./services/sessionStore";
import { WebhookDispatcher } from "./services/webhookDispatcher";
import { WebhookOutbox } from "./services/webhookOutbox";

export interface AppContext {
  app: express.Express;
  sessionStore: InMemorySessionStore;
  webhookDispatcher: WebhookDispatcher;
  postMeetingProcessor: PostMeetingProcessor;
  storage: StorageBackends;
}

export async function createApp(): Promise<AppContext> {
  const app = express();
  const storage = await createStorageBackends();
  const { sessionStore, interviewStore, meetingStore } = storage;

  const openAIClient = new OpenAIRealtimeClient();
  const jobAiClient = new JobAiClient();
  const interviewService = new InterviewSyncService(jobAiClient, interviewStore);
  const meetingStateMachine = new MeetingStateMachine();
  const webhookOutbox = new WebhookOutbox({
    redis: storage.redis,
    prefix: env.REDIS_PREFIX
  });
  await webhookOutbox.loadAll();
  const postMeetingProcessor = new PostMeetingProcessor(webhookOutbox);
  const webhookDispatcher = new WebhookDispatcher(webhookOutbox);
  const runtimeEvents = new RuntimeEventStore({
    redis: storage.redis,
    prefix: env.REDIS_PREFIX
  });
  const runtimeLeases = new RuntimeLeaseStore({
    redis: storage.redis,
    prefix: env.REDIS_PREFIX
  });
  const avatarClient = new AvatarClient();
  const avatarStateStore = new AvatarStateStore();
  const streamProvisioner =
    avatarClient.isConfigured() && env.STREAM_API_KEY && env.STREAM_API_SECRET
      ? new StreamProvisioner({
          apiKey: env.STREAM_API_KEY,
          apiSecret: env.STREAM_API_SECRET,
          baseUrl: env.STREAM_BASE_URL
        })
      : undefined;
  const streamRecordingService =
    env.STREAM_API_KEY && env.STREAM_API_SECRET
      ? new StreamRecordingService({
          apiKey: env.STREAM_API_KEY,
          apiSecret: env.STREAM_API_SECRET,
          callType: env.STREAM_CALL_TYPE,
          baseUrl: env.STREAM_BASE_URL
        })
      : undefined;
  const meetingOrchestrator = new MeetingOrchestrator(
    meetingStore,
    meetingStateMachine,
    webhookOutbox,
    postMeetingProcessor,
    avatarClient.isConfigured()
      ? {
          client: avatarClient,
          stateStore: avatarStateStore,
          streamProvisioner,
          streamCallType: env.STREAM_CALL_TYPE
        }
      : undefined,
    runtimeEvents,
    streamRecordingService
  );
  const runtimeSnapshots = new RuntimeSnapshotService({
    meetingStore,
    sessionStore,
    interviewStore,
    avatarStateStore,
    runtimeEvents,
    streamCallType: env.STREAM_CALL_TYPE
  });

  if (avatarClient.isConfigured()) {
    logger.info(
      {
        avatarPodUrl: env.AVATAR_POD_URL,
        avatarDefaultKey: env.AVATAR_DEFAULT_KEY,
        streamCallType: env.STREAM_CALL_TYPE
      },
      "avatar service wiring enabled — POST /meetings/start will kick off pod"
    );
  } else {
    logger.warn(
      { avatarEnabled: env.AVATAR_ENABLED },
      "avatar service wiring disabled (set AVATAR_ENABLED=true and provide AVATAR_POD_URL/AVATAR_SHARED_TOKEN/STREAM_API_KEY/STREAM_API_SECRET to enable)"
    );
  }

  const metrics = env.METRICS_ENABLED
    ? createMetricsContext({
        sessionStore,
        webhookOutbox,
        redisReconnects: storage.redisReconnects
      })
    : undefined;

  app.disable("x-powered-by");
  if (env.RATE_LIMIT_TRUST_PROXY) {
    app.set("trust proxy", 1);
  }

  app.use(createCorsMiddleware());
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

  if (metrics) {
    app.use(metrics.middleware);
  }

  // Serve post-processing artifacts (best-effort; directory must exist on host).
  app.use("/artifacts", express.static(env.ARTIFACTS_DIR, { fallthrough: true }));

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({
      status: "ok",
      uptimeSeconds: process.uptime(),
      timestamp: new Date().toISOString()
    });
  });

  app.get(
    "/health/ready",
    createReadinessHandler({
      redis: storage.redis,
      redisReconnects: storage.redisReconnects,
      webhookOutbox,
      hasOpenAIKey: Boolean(env.OPENAI_API_KEY)
    })
  );

  if (metrics) {
    app.get("/metrics", (req, res, next) => {
      void metrics.handler(req, res).catch(next);
    });
  }

  // ---------------- routers ----------------
  app.use(
    "/realtime",
    (req, res, next) => {
      // Применяем разные лимиты по подмаршрутам, не оборачивая весь роутер.
      if (req.method === "POST" && req.path === "/session") {
        return realtimeSessionLimiter(req, res, next);
      }
      if (req.method === "GET" && req.path === "/token") {
        return realtimeTokenLimiter(req, res, next);
      }
      next();
    },
    createRealtimeRouter({
      openAIClient,
      sessionStore,
      runtimeEvents
    })
  );

  app.use(
    "/meetings",
    (req, res, next) => {
      if (req.method === "POST" && /^\/[^/]+\/admission\/candidate(\/|$)/.test(req.path)) {
        return admissionLimiter(req, res, next);
      }
      next();
    },
    createMeetingRouter(meetingOrchestrator, {
      recordings: streamRecordingService,
      interviews: interviewService
    })
  );

  // M3: signed join links (mounted before generic interviews router so that
  // /interviews/:jobAiId/links/* is matched first; existing /interviews/:id GET
  // handlers remain reachable because Express tries handlers in order and
  // joinLinks routes only register /links/* sub-paths).
  if (env.JOIN_TOKEN_SECRET) {
    const joinTokenSigner = new JoinTokenSigner(env.JOIN_TOKEN_SECRET);
    const observerTicketSigner = new ObserverSessionTicketSigner(env.JOIN_TOKEN_SECRET);
    const observerTicketStore = storage.redis
      ? new RedisObserverSessionTicketStore({
          redis: storage.redis,
          prefix: env.REDIS_PREFIX
        })
      : new InMemoryObserverSessionTicketStore();
    const joinLinksDeps = {
      signer: joinTokenSigner,
      store: storage.joinTokenStore,
      observerTicketSigner,
      observerTicketStore,
      resolveMeetingIdByInterview: async (jobAiId: number) => {
        try {
          const snapshot = await runtimeSnapshots.getByInterviewId(jobAiId);
          return snapshot.meetingId;
        } catch {
          return null;
        }
      }
    };
    app.use("/interviews", createJoinLinksIssueRouter(joinLinksDeps));
    app.use("/join", createJoinPublicRouter(joinLinksDeps));
    logger.info({ frontendBaseUrl: env.JOIN_TOKEN_FRONTEND_BASE_URL }, "join links routes enabled");
  } else {
    logger.warn("JOIN_TOKEN_SECRET not set — signed join links routes are disabled");
  }

  app.use("/interviews", createInterviewsRouter(interviewService));
  app.use("/api/v1", createTzAliasRouter(interviewService, jobAiClient));
  app.use(
    "/runtime",
    createRuntimeRouter({
      snapshots: runtimeSnapshots,
      events: runtimeEvents,
      leases: runtimeLeases,
      meetingOrchestrator
    })
  );

  app.use(
    "/avatar",
    createAvatarRouter({ avatarClient, stateStore: avatarStateStore, meetingOrchestrator, runtimeEvents })
  );
  app.use(
    "/",
    (req, res, next) => {
      if (req.method === "POST" && req.path.startsWith("/jobai/")) {
        return jobaiIngestLimiter(req, res, next);
      }
      if (req.method === "POST" && req.path.startsWith("/webhooks/jobai")) {
        return jobaiIngestLimiter(req, res, next);
      }
      next();
    },
    createJobAiRouter(interviewService, jobAiClient)
  );

  app.get("/ops/webhooks", (_req: Request, res: Response) => {
    res.status(200).json({
      webhookQueue: webhookOutbox.getStats()
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, sessionStore, webhookDispatcher, postMeetingProcessor, storage };
}
