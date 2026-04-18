import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_REALTIME_MODEL: z.string().default("gpt-realtime"),
  OPENAI_REALTIME_VOICE: z.string().default("marin"),
  SESSION_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
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
  JOBAI_INGEST_SECRET: z.string().min(8).optional()
}).superRefine((values, ctx) => {
  if (!values.JOBAI_WEBHOOK_ENABLED) {
    return;
  }

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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const formattedErrors = parsed.error.errors
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment configuration: ${formattedErrors}`);
}

export const env = parsed.data;
