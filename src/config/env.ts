import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_REALTIME_MODEL: z.string().default("gpt-realtime"),
  // Realtime built-in voices per OpenAI docs include:
  // alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar.
  // Default to a feminine sounding voice for HR interviewer tone.
  OPENAI_REALTIME_VOICE: z.string().default("coral"),
  OPENAI_TURN_DETECTION_ENABLED: z.coerce.boolean().default(false),
  OPENAI_TURN_DETECTION_TYPE: z.enum(["server_vad"]).default("server_vad"),
  OPENAI_TURN_DETECTION_THRESHOLD: z.coerce.number().min(0).max(1).default(0.72),
  OPENAI_TURN_DETECTION_PREFIX_PADDING_MS: z.coerce.number().int().min(0).default(450),
  OPENAI_TURN_DETECTION_SILENCE_DURATION_MS: z.coerce.number().int().min(100).default(900),
  SESSION_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  SESSION_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  SDP_MAX_BYTES: z.coerce.number().int().positive().default(200000),
  OPENAI_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  JOBAI_WEBHOOK_ENABLED: z.coerce.boolean().default(false),
  JOBAI_WEBHOOK_URL: z.string().url().optional(),
  JOBAI_WEBHOOK_SECRET: z.string().min(16).optional(),
  JOBAI_WEBHOOK_DISPATCH_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  JOBAI_WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(4),
  JOBAI_API_BASE_URL: z.string().url().optional(),
  JOBAI_API_AUTH_MODE: z.enum(["none", "bearer", "basic"]).default("none"),
  JOBAI_API_TOKEN: z.string().min(1).optional(),
  JOBAI_API_BASIC_USER: z.string().min(1).optional(),
  JOBAI_API_BASIC_PASSWORD: z.string().min(1).optional(),
  JOBAI_INGEST_SECRET: z.string().min(8).optional(),
  STORAGE_BACKEND: z.enum(["memory", "redis"]).default("memory"),
  REDIS_URL: z.string().url().optional(),
  REDIS_PREFIX: z.string().default("nullxes:hr-ai"),
  REDIS_SESSION_TTL_MS: z.coerce.number().int().positive().default(86400000),
  REDIS_RECONNECT_MAX_DELAY_MS: z.coerce.number().int().positive().default(30000),
  REDIS_HEARTBEAT_MS: z.coerce.number().int().positive().default(15000),
  REDIS_COMMAND_QUEUE_LIMIT: z.coerce.number().int().positive().default(100),
  CORS_ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  METRICS_ENABLED: z.coerce.boolean().default(true),
  RATE_LIMIT_ENABLED: z.coerce.boolean().default(true),
  RATE_LIMIT_TRUST_PROXY: z.coerce.boolean().default(true),
  CANDIDATE_ADMISSION_REJOIN_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  MEETING_STALE_TIMEOUT_MS: z.coerce.number().int().positive().default(14_400_000),
  MEETING_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  // M3: signed candidate / spectator join links
  // JOIN_TOKEN_SECRET is required only when join-link issuance is in use; we keep
  // it optional in the schema so existing droplet boots don't break before the
  // operator generates a secret. Issuance routes refuse to start without it.
  JOIN_TOKEN_SECRET: z.string().min(32).optional(),
  JOIN_TOKEN_DEFAULT_TTL_MS: z.coerce.number().int().positive().default(86_400_000),
  OBSERVER_SESSION_TICKET_TTL_MS: z.coerce.number().int().positive().default(120_000),
  JOIN_TOKEN_FRONTEND_BASE_URL: z.string().url().default("http://localhost:3000"),
  JOIN_TOKEN_AUDIT_LIMIT: z.coerce.number().int().positive().default(100),
  // Avatar service (RunPod H200 pod, see avatarservicenullxes)
  AVATAR_ENABLED: z.coerce.boolean().default(false),
  AVATAR_POD_URL: z.string().url().optional(),
  AVATAR_SHARED_TOKEN: z.string().min(16).optional(),
  AVATAR_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  AVATAR_DEFAULT_KEY: z.string().min(1).default("anna"),
  AVATAR_DEFAULT_EMOTION: z.string().min(1).default("neutral"),
  AVATAR_REFERENCE_IMAGE_URL: z.string().url().optional(),
  // Stream SFU (used by avatar pod and frontend; gateway only forwards keys to pod)
  STREAM_API_KEY: z.string().min(1).optional(),
  STREAM_API_SECRET: z.string().min(1).optional(),
  STREAM_BASE_URL: z.string().url().default("https://video.stream-io-api.com"),
  STREAM_CALL_TYPE: z.string().min(1).default("default"),
  // Stream OpenAI agent (Phase 1): backend-owned Stream participant for recording.
  // Disabled by default to avoid double-agent until frontend Phase 2 is implemented.
  STREAM_OPENAI_AGENT_ENABLED: z.coerce.boolean().default(false),
  STREAM_OPENAI_AGENT_MODEL: z.string().default(""),
  STREAM_OPENAI_AGENT_VOICE: z.string().default(""),
  STREAM_OPENAI_AGENT_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  STREAM_OPENAI_AGENT_VALIDITY_SECONDS: z.coerce.number().int().min(60).default(3600),
  // Backward-compat: previous flag name. Keep until droplet envs are migrated.
  ENABLE_STREAM_OPENAI_AGENT: z.coerce.boolean().default(false),
  // Post-processing artifacts (assistant audio capture + optional merge)
  ARTIFACTS_DIR: z.string().min(1).default("/var/lib/nullxes-hr/artifacts"),
  ASSISTANT_AUDIO_MAX_BYTES: z.coerce.number().int().positive().default(25_000_000)
}).superRefine((values, ctx) => {
  if (values.JOBAI_WEBHOOK_ENABLED) {
    if (!values.JOBAI_WEBHOOK_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JOBAI_WEBHOOK_URL"],
        message: "JOBAI_WEBHOOK_URL is required when JOBAI_WEBHOOK_ENABLED=true"
      });
    }

    if (!values.JOBAI_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JOBAI_WEBHOOK_SECRET"],
        message: "JOBAI_WEBHOOK_SECRET is required when JOBAI_WEBHOOK_ENABLED=true"
      });
    }
  }

  if (values.JOBAI_API_AUTH_MODE === "bearer" && !values.JOBAI_API_TOKEN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["JOBAI_API_TOKEN"],
      message: "JOBAI_API_TOKEN is required when JOBAI_API_AUTH_MODE=bearer"
    });
  }

  if (
    values.JOBAI_API_AUTH_MODE === "basic" &&
    (!values.JOBAI_API_BASIC_USER || !values.JOBAI_API_BASIC_PASSWORD)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["JOBAI_API_BASIC_USER"],
      message: "JOBAI_API_BASIC_USER and JOBAI_API_BASIC_PASSWORD are required when JOBAI_API_AUTH_MODE=basic"
    });
  }

  if (values.STORAGE_BACKEND === "redis" && !values.REDIS_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["REDIS_URL"],
      message: "REDIS_URL is required when STORAGE_BACKEND=redis"
    });
  }

  if (values.AVATAR_ENABLED) {
    if (!values.AVATAR_POD_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AVATAR_POD_URL"],
        message: "AVATAR_POD_URL is required when AVATAR_ENABLED=true"
      });
    }
    if (!values.AVATAR_SHARED_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AVATAR_SHARED_TOKEN"],
        message: "AVATAR_SHARED_TOKEN is required when AVATAR_ENABLED=true"
      });
    }
    if (!values.STREAM_API_KEY || !values.STREAM_API_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["STREAM_API_KEY"],
        message: "STREAM_API_KEY and STREAM_API_SECRET are required when AVATAR_ENABLED=true (gateway forwards them to the pod)"
      });
    }
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const formattedErrors = parsed.error.errors
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment configuration: ${formattedErrors}`);
}

export const env = parsed.data;
export type AppEnv = typeof env;
