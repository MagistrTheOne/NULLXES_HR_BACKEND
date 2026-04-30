import { StreamClient } from "@stream-io/node-sdk";
import type { RealtimeClient } from "@stream-io/openai-realtime-api";
import { env } from "../config/env";
import { logger } from "../logging/logger";
import type { StreamProvisioner } from "./streamProvisioner";

export type StreamOpenAiAgentState = "disabled" | "connecting" | "connected" | "failed" | "closed";

export type ConnectStreamOpenAiAgentInput = {
  meetingId: string;
  sessionId: string;
  jobAiId?: number | null;
  callType: string;
  callId: string;
  agentUserId: string;
  instructions: string;
  voice?: string;
  model?: string;
};

export type ConnectStreamOpenAiAgentResult = {
  transport: "stream_openai";
  agentUserId: string;
  state: StreamOpenAiAgentState;
  connectedAt?: number;
  error?: string;
};

type ActiveAgentConnection = {
  agentUserId: string;
  callType: string;
  callId: string;
  connectedAt: number;
  state: StreamOpenAiAgentState;
  lastError?: string;
  realtimeClient?: RealtimeClient;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isEnabledByEnv(): boolean {
  return Boolean(env.STREAM_OPENAI_AGENT_ENABLED || env.ENABLE_STREAM_OPENAI_AGENT);
}

function resolveModel(): string {
  const explicit = env.STREAM_OPENAI_AGENT_MODEL?.trim();
  return explicit && explicit.length > 0 ? explicit : env.OPENAI_REALTIME_MODEL;
}

function resolveVoice(): string {
  const explicit = env.STREAM_OPENAI_AGENT_VOICE?.trim();
  return explicit && explicit.length > 0 ? explicit : env.OPENAI_REALTIME_VOICE;
}

function withJobAiGuardrails(instructions: string): string {
  return [
    instructions,
    "",
    "КРИТИЧНО: отвечай только на русском языке.",
    "КРИТИЧНО: не переходи на английский, китайский или другой язык.",
    "КРИТИЧНО: не говори 'чем могу помочь сегодня'. Ты уже находишься в интервью.",
    "КРИТИЧНО: используй только вопросы из списка JobAI, по одному вопросу за раз.",
    "КРИТИЧНО: не меняй нумерацию вопросов и не придумывай новые номера."
  ].join("\n");
}

function readRealtimeEventError(event: unknown): { code?: string; message?: string } {
  if (!event || typeof event !== "object") return {};
  const record = event as Record<string, unknown>;
  const error = record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : record;
  const code = typeof error.code === "string" ? error.code : undefined;
  const message = typeof error.message === "string" ? error.message : undefined;
  return { code, message };
}

export interface StreamOpenAiAgentServiceInput {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
  streamProvisioner?: StreamProvisioner;
}

/**
 * Phase 1 service: connects a backend-owned OpenAI agent into a Stream call using
 * Stream's OpenAI Realtime integration (`connectOpenAi`).
 *
 * IMPORTANT: Disabled by default. When enabled, frontend must be migrated in Phase 2
 * to avoid double-agent (browser OpenAI voice + Stream agent voice).
 */
export class StreamOpenAiAgentService {
  private readonly streamClient: StreamClient;
  private readonly provisioner?: StreamProvisioner;
  private readonly activeByMeetingId = new Map<string, ActiveAgentConnection>();

  constructor(input: StreamOpenAiAgentServiceInput) {
    this.streamClient = new StreamClient(input.apiKey, input.apiSecret, {
      basePath: input.baseUrl
    });
    this.provisioner = input.streamProvisioner;
  }

  isEnabled(): boolean {
    return isEnabledByEnv();
  }

  getActive(meetingId: string): ActiveAgentConnection | undefined {
    return this.activeByMeetingId.get(meetingId);
  }

  private markFailed(input: ConnectStreamOpenAiAgentInput, message: string): ConnectStreamOpenAiAgentResult {
    this.activeByMeetingId.set(input.meetingId, {
      agentUserId: input.agentUserId,
      callType: input.callType,
      callId: input.callId,
      connectedAt: Date.now(),
      state: "failed",
      lastError: message
    });
    return { transport: "stream_openai", agentUserId: input.agentUserId, state: "failed", error: message };
  }

  private subscribeToRealtimeEvents(realtimeClient: RealtimeClient, input: ConnectStreamOpenAiAgentInput): void {
    try {
      const anyClient = realtimeClient as unknown as { on?: (event: string, cb: (payload: unknown) => void) => void };
      if (typeof anyClient.on !== "function") return;

      const events = [
        "error",
        "session.created",
        "session.updated",
        "response.created",
        "response.done",
        "conversation.item.created"
      ];

      for (const eventType of events) {
        anyClient.on(eventType, (payload: unknown) => {
          const error = readRealtimeEventError(payload);
          const logPayload = {
            meetingId: input.meetingId,
            agentUserId: input.agentUserId,
            eventType,
            ...(error.code ? { errorCode: error.code } : {}),
            ...(error.message ? { errorMessage: error.message } : {})
          };
          if (eventType === "error") {
            logger.warn(logPayload, "stream openai agent realtime event");
          } else {
            logger.info(logPayload, "stream openai agent realtime event");
          }
        });
      }
    } catch {
      // Event diagnostics must never break the agent boot path.
    }
  }

  private async cleanupRealtimeClient(realtimeClient: RealtimeClient): Promise<void> {
    try {
      const maybeDisconnect = (realtimeClient as unknown as { disconnect?: () => unknown }).disconnect;
      const maybeClose = (realtimeClient as unknown as { close?: () => unknown }).close;
      if (maybeDisconnect) await maybeDisconnect();
      else if (maybeClose) await maybeClose();
    } catch {
      // Ignore cleanup errors; the fatal boot log above is the actionable signal.
    }
  }

  async connectAgentToCall(input: ConnectStreamOpenAiAgentInput): Promise<ConnectStreamOpenAiAgentResult> {
    if (!this.isEnabled()) {
      return { transport: "stream_openai", agentUserId: input.agentUserId, state: "disabled" };
    }

    const existing = this.activeByMeetingId.get(input.meetingId);
    if (existing?.state === "connected" && existing.agentUserId === input.agentUserId) {
      return {
        transport: "stream_openai",
        agentUserId: existing.agentUserId,
        state: existing.state,
        connectedAt: existing.connectedAt
      };
    }

    this.activeByMeetingId.set(input.meetingId, {
      agentUserId: input.agentUserId,
      callType: input.callType,
      callId: input.callId,
      connectedAt: Date.now(),
      state: "connecting"
    });

    logger.warn(
      {
        meetingId: input.meetingId,
        note: "Browser OpenAI Realtime must be disabled in Phase 2 to avoid double-agent."
      },
      "stream_openai_agent_enabled_requires_frontend_agent_mode"
    );
    // TODO(phase2): when NEXT_PUBLIC_STREAM_OPENAI_AGENT_MODE=1, frontend must not start browser speaking OpenAI Realtime session.

    try {
      const resolvedModel = input.model ?? resolveModel();
      const resolvedVoice = input.voice ?? resolveVoice();
      const instructions = withJobAiGuardrails(input.instructions);

      logger.info(
        {
          meetingId: input.meetingId,
          streamOpenAiAgentEnabled: Boolean(env.STREAM_OPENAI_AGENT_ENABLED),
          openAiRealtimeModel: env.OPENAI_REALTIME_MODEL,
          resolvedModel,
          resolvedVoice,
          hasOpenAiApiKey: Boolean(env.OPENAI_API_KEY)
        },
        "stream openai agent env sanity"
      );

      if (this.provisioner) {
        await this.provisioner.provisionAgentForCall({
          callType: input.callType,
          callId: input.callId,
          agentUserId: input.agentUserId,
          agentDisplayName: "HR ассистент",
          candidateUserId: `candidate-${input.meetingId}`.replace(/[^a-zA-Z0-9_-]/g, "-"),
          candidateDisplayName: "Candidate"
        });
      }

      logger.info(
        {
          meetingId: input.meetingId,
          sessionId: input.sessionId,
          jobAiId: input.jobAiId ?? null,
          callType: input.callType,
          callId: input.callId,
          agentUserId: input.agentUserId,
          model: resolvedModel
        },
        "stream openai agent connecting"
      );

      const call = this.streamClient.video.call(input.callType, input.callId);

      logger.info(
        {
          meetingId: input.meetingId,
          callType: input.callType,
          callId: input.callId,
          agentUserId: input.agentUserId,
          model: resolvedModel,
          voice: resolvedVoice,
          instructionsLength: instructions.length
        },
        "stream openai agent connectOpenAi requested"
      );

      const realtimeClient = await withTimeout(
        this.streamClient.video.connectOpenAi({
          call,
          openAiApiKey: env.OPENAI_API_KEY,
          agentUserId: input.agentUserId,
          model: resolvedModel as never
        }),
        env.STREAM_OPENAI_AGENT_CONNECT_TIMEOUT_MS,
        "stream connectOpenAi"
      );

      logger.info(
        {
          meetingId: input.meetingId,
          callType: input.callType,
          callId: input.callId,
          agentUserId: input.agentUserId
        },
        "stream openai agent connected"
      );

      this.subscribeToRealtimeEvents(realtimeClient, input);

      try {
        await realtimeClient.updateSession({
          instructions,
          voice: resolvedVoice as never
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.markFailed(input, message);
        logger.warn(
          { meetingId: input.meetingId, agentUserId: input.agentUserId, error: message },
          "stream openai agent updateSession failed fatal"
        );
        await this.cleanupRealtimeClient(realtimeClient);
        return { transport: "stream_openai", agentUserId: input.agentUserId, state: "failed", error: message };
      }

      logger.info(
        {
          meetingId: input.meetingId,
          agentUserId: input.agentUserId,
          instructionsLength: instructions.length
        },
        "stream openai agent session updated"
      );

      try {
        await realtimeClient.sendUserMessageContent([
          {
            type: "input_text",
            text:
              "Начни интервью сейчас. Следуй системным инструкциям JobAI. Не спрашивай, чем помочь. Поздоровайся с кандидатом по имени, если имя известно, затем сразу задай первый вопрос из списка. Веди интервью только на русском языке."
          }
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.markFailed(input, message);
        logger.warn(
          { meetingId: input.meetingId, agentUserId: input.agentUserId, error: message },
          "stream openai agent kickoff failed"
        );
        await this.cleanupRealtimeClient(realtimeClient);
        return { transport: "stream_openai", agentUserId: input.agentUserId, state: "failed", error: message };
      }

      logger.info({ meetingId: input.meetingId, agentUserId: input.agentUserId }, "stream openai agent kickoff sent");

      const connectedAt = Date.now();
      this.activeByMeetingId.set(input.meetingId, {
        agentUserId: input.agentUserId,
        callType: input.callType,
        callId: input.callId,
        connectedAt,
        state: "connected",
        realtimeClient
      });
      return {
        transport: "stream_openai",
        agentUserId: input.agentUserId,
        state: "connected",
        connectedAt
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.markFailed(input, message);
      logger.warn(
        {
          meetingId: input.meetingId,
          callType: input.callType,
          callId: input.callId,
          agentUserId: input.agentUserId,
          error: message
        },
        "stream openai agent connect failed"
      );
      return { transport: "stream_openai", agentUserId: input.agentUserId, state: "failed", error: message };
    }
  }

  async disconnectAgent(meetingId: string, reason: string): Promise<void> {
    const active = this.activeByMeetingId.get(meetingId);
    if (!active) return;
    this.activeByMeetingId.set(meetingId, { ...active, state: "closed" });
    const client = active.realtimeClient;
    if (!client) return;
    try {
      const maybeDisconnect = (client as unknown as { disconnect?: () => unknown }).disconnect;
      const maybeClose = (client as unknown as { close?: () => unknown }).close;
      if (maybeDisconnect) await maybeDisconnect();
      else if (maybeClose) await maybeClose();
      logger.info({ meetingId, reason, agentUserId: active.agentUserId }, "stream openai agent disconnected");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ meetingId, reason, agentUserId: active.agentUserId, error: message }, "stream openai agent disconnect failed");
    }
  }
}

