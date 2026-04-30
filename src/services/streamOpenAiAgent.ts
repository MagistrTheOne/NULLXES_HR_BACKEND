import { StreamClient } from "@stream-io/node-sdk";
import type { RealtimeClient } from "@stream-io/openai-realtime-api";
import { env } from "../config/env";
import { logger } from "../logging/logger";
import type { StreamProvisioner } from "./streamProvisioner";

type ActiveAgentConnection = {
  agentUserId: string;
  callType: string;
  callId: string;
  connectedAt: number;
  realtimeClient: RealtimeClient;
};

function truthyFlag(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true" || v === "TRUE" || v === "yes";
}

export interface StreamOpenAiAgentInput {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
  streamProvisioner?: StreamProvisioner;
}

/**
 * Minimal wrapper around Stream Video `connectOpenAi`.
 *
 * Goal: ensure the AI agent joins the Stream call as a participant and publishes
 * a Stream audio track so that Stream recording captures assistant voice.
 */
export class StreamOpenAiAgent {
  private readonly streamClient: StreamClient;
  private readonly provisioner?: StreamProvisioner;
  private readonly activeByMeetingId = new Map<string, ActiveAgentConnection>();

  constructor(input: StreamOpenAiAgentInput) {
    this.streamClient = new StreamClient(input.apiKey, input.apiSecret, {
      basePath: input.baseUrl
    });
    this.provisioner = input.streamProvisioner;
  }

  isGloballyEnabled(): boolean {
    return Boolean(env.ENABLE_STREAM_OPENAI_AGENT);
  }

  isEnabledForMeeting(metadata: Record<string, unknown> | undefined): boolean {
    const override = metadata?.enable_stream_openai_agent;
    return this.isGloballyEnabled() || truthyFlag(override);
  }

  getActive(meetingId: string): ActiveAgentConnection | undefined {
    return this.activeByMeetingId.get(meetingId);
  }

  async ensureConnected(opts: {
    meetingId: string;
    metadata?: Record<string, unknown>;
    callType: string;
    callId: string;
    agentUserId: string;
    agentDisplayName?: string;
    candidateUserId?: string;
    candidateDisplayName?: string;
  }): Promise<void> {
    if (!this.isEnabledForMeeting(opts.metadata)) return;

    const existing = this.activeByMeetingId.get(opts.meetingId);
    if (existing && existing.agentUserId === opts.agentUserId) {
      return;
    }

    const backoff = [2_000, 4_000, 8_000, 15_000, 15_000] as const;
    for (let attempt = 1; attempt <= backoff.length; attempt += 1) {
      try {
        logger.info(
          {
            meetingId: opts.meetingId,
            callType: opts.callType,
            callId: opts.callId,
            agentUserId: opts.agentUserId,
            attempt
          },
          "stream connectOpenAi attempting"
        );

        if (this.provisioner) {
          await this.provisioner.provisionAgentForCall({
            callType: opts.callType,
            callId: opts.callId,
            agentUserId: opts.agentUserId,
            agentDisplayName: opts.agentDisplayName,
            candidateUserId: opts.candidateUserId,
            candidateDisplayName: opts.candidateDisplayName
          });
        }

        const call = this.streamClient.video.call(opts.callType, opts.callId);
        const realtimeClient = await this.streamClient.video.connectOpenAi({
          call,
          agentUserId: opts.agentUserId,
          openAiApiKey: env.OPENAI_API_KEY,
          model: env.OPENAI_REALTIME_MODEL as unknown as never,
          validityInSeconds: env.STREAM_OPENAI_AGENT_VALIDITY_SECONDS
        });

        // Best-effort session update for voice selection (non-fatal).
        try {
          const maybeUpdateSession = (realtimeClient as unknown as { updateSession?: (v: unknown) => unknown })
            .updateSession;
          if (maybeUpdateSession) {
            await maybeUpdateSession({
              voice: env.OPENAI_REALTIME_VOICE,
              turn_detection: env.OPENAI_TURN_DETECTION_ENABLED
                ? {
                    type: env.OPENAI_TURN_DETECTION_TYPE,
                    threshold: env.OPENAI_TURN_DETECTION_THRESHOLD,
                    prefix_padding_ms: env.OPENAI_TURN_DETECTION_PREFIX_PADDING_MS,
                    silence_duration_ms: env.OPENAI_TURN_DETECTION_SILENCE_DURATION_MS
                  }
                : null
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn({ meetingId: opts.meetingId, error: message }, "stream connectOpenAi updateSession failed");
        }

        this.activeByMeetingId.set(opts.meetingId, {
          agentUserId: opts.agentUserId,
          callType: opts.callType,
          callId: opts.callId,
          connectedAt: Date.now(),
          realtimeClient
        });

        logger.info(
          {
            meetingId: opts.meetingId,
            callType: opts.callType,
            callId: opts.callId,
            agentUserId: opts.agentUserId
          },
          "stream connectOpenAi connected"
        );
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          {
            meetingId: opts.meetingId,
            callType: opts.callType,
            callId: opts.callId,
            agentUserId: opts.agentUserId,
            attempt,
            error: message
          },
          "stream connectOpenAi failed"
        );
        if (attempt >= backoff.length) return;
        await new Promise((resolve) => setTimeout(resolve, backoff[attempt - 1]));
      }
    }
  }

  async disconnect(meetingId: string, reason: string): Promise<void> {
    const active = this.activeByMeetingId.get(meetingId);
    if (!active) return;
    this.activeByMeetingId.delete(meetingId);
    try {
      const maybeDisconnect = (active.realtimeClient as unknown as { disconnect?: () => unknown }).disconnect;
      const maybeClose = (active.realtimeClient as unknown as { close?: () => unknown }).close;
      if (maybeDisconnect) await maybeDisconnect();
      else if (maybeClose) await maybeClose();
      logger.info({ meetingId, reason, agentUserId: active.agentUserId }, "stream connectOpenAi disconnected");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ meetingId, reason, agentUserId: active.agentUserId, error: message }, "stream connectOpenAi disconnect failed");
    }
  }
}

