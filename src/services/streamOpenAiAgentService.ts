import { StreamClient } from "@stream-io/node-sdk";
import { createRealtimeClient, type RealtimeClient } from "@stream-io/openai-realtime-api";
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
  private readonly apiKey: string;
  private readonly baseUrl?: string;
  private readonly provisioner?: StreamProvisioner;
  private readonly activeByMeetingId = new Map<string, ActiveAgentConnection>();

  constructor(input: StreamOpenAiAgentServiceInput) {
    this.apiKey = input.apiKey;
    this.baseUrl = input.baseUrl;
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
          model: input.model ?? resolveModel()
        },
        "stream openai agent connecting"
      );

      const streamUserToken = this.streamClient.generateCallToken({
        user_id: input.agentUserId,
        call_cids: [`${input.callType}:${input.callId}`],
        validity_in_seconds: env.STREAM_OPENAI_AGENT_VALIDITY_SECONDS
      });

      const realtimeClient = createRealtimeClient({
        baseUrl: this.baseUrl ?? "https://video.stream-io-api.com",
        call: { type: input.callType, id: input.callId },
        streamApiKey: this.apiKey,
        streamUserToken,
        openAiApiKey: env.OPENAI_API_KEY,
        model: (input.model ?? resolveModel()) as never
      });

      // Set the JobAI interview prompt BEFORE connect(). The OpenAI reference client
      // sends its session config during connect(); applying instructions only after
      // Stream's connectOpenAi() returns can leave the agent in generic assistant mode.
      realtimeClient.updateSession({
        instructions: input.instructions,
        voice: (input.voice ?? resolveVoice()) as never
      });

      await withTimeout(
        realtimeClient.connect(),
        env.STREAM_OPENAI_AGENT_CONNECT_TIMEOUT_MS,
        "stream connectOpenAi"
      );

      // Best-effort updateSession (non-fatal)
      try {
        // IMPORTANT: do NOT extract updateSession into a variable without binding.
        // Some client implementations rely on `this.sessionConfig` and will throw
        // if called unbound (e.g. "Cannot read properties of undefined (reading 'sessionConfig')").
        const maybeUpdateSession = (realtimeClient as unknown as { updateSession?: (v: unknown) => unknown })
          .updateSession;
        if (typeof maybeUpdateSession === "function") {
          await (maybeUpdateSession as (this: unknown, v: unknown) => unknown).call(realtimeClient, {
            instructions: input.instructions,
            voice: input.voice ?? resolveVoice()
          });
          logger.info(
            {
              meetingId: input.meetingId,
              agentUserId: input.agentUserId,
              instructionsLength: input.instructions.length
            },
            "stream openai agent session updated"
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ meetingId: input.meetingId, error: message }, "stream openai agent updateSession failed");
      }

      // Best-effort "kick" to ensure the agent starts speaking from JobAI instructions.
      // Correct API for OpenAI reference client is sendUserMessageContent([...]) which triggers createResponse().
      try {
        const anyClient = realtimeClient as unknown as {
          sendUserMessageContent?: (content: Array<{ type: string; text?: string }>) => unknown;
          createResponse?: () => unknown;
        };
        const kickoffText =
          "Начни интервью сейчас. НЕ отвечай как общий ассистент и НЕ спрашивай «чем могу помочь». " +
          "Следуй session instructions (JobAI сценарий). Скажи приветствие из блока JobAI и сразу задай первый вопрос из списка.";
        if (typeof anyClient.sendUserMessageContent === "function") {
          await anyClient.sendUserMessageContent([{ type: "input_text", text: kickoffText }]);
          logger.info({ meetingId: input.meetingId, agentUserId: input.agentUserId }, "stream openai agent kickoff sent");
        } else if (typeof anyClient.createResponse === "function") {
          // Fallback: force a response generation based on session instructions only.
          await anyClient.createResponse();
          logger.info(
            { meetingId: input.meetingId, agentUserId: input.agentUserId, note: "createResponse fallback" },
            "stream openai agent kickoff sent"
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ meetingId: input.meetingId, error: message }, "stream openai agent kickoff failed");
      }

      // Best-effort event subscriptions (do not assume exact emitter API).
      try {
        const anyClient = realtimeClient as unknown as { on?: (event: string, cb: (...args: any[]) => void) => void };
        if (typeof anyClient.on === "function") {
          anyClient.on("error", (e: unknown) => {
            const message = e instanceof Error ? e.message : String(e);
            logger.warn({ meetingId: input.meetingId, error: message }, "stream openai agent runtime error");
          });
        }
      } catch {
        // ignore
      }

      const connectedAt = Date.now();
      this.activeByMeetingId.set(input.meetingId, {
        agentUserId: input.agentUserId,
        callType: input.callType,
        callId: input.callId,
        connectedAt,
        state: "connected",
        realtimeClient
      });

      logger.info(
        { meetingId: input.meetingId, callType: input.callType, callId: input.callId, agentUserId: input.agentUserId },
        "stream openai agent connected"
      );
      return {
        transport: "stream_openai",
        agentUserId: input.agentUserId,
        state: "connected",
        connectedAt
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.activeByMeetingId.set(input.meetingId, {
        agentUserId: input.agentUserId,
        callType: input.callType,
        callId: input.callId,
        connectedAt: Date.now(),
        state: "failed",
        lastError: message
      });
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

