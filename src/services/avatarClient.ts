import { env } from "../config/env";
import { logger } from "../logging/logger";
import { mintStreamUserToken } from "./streamCallTokenService";

/**
 * HTTP client to the avatar pod (avatarservicenullxes on RunPod H200).
 * Implements the `POST /sessions` and `DELETE /sessions/{sid}` calls described
 * in `avatarservicenullxes/docs/API_CONTRACT.md`.
 *
 * The gateway is the SOURCE OF TRUTH for OpenAI instructions and Stream credentials;
 * the pod treats this payload as immutable for the lifetime of the session.
 */

export interface CreateAvatarSessionInput {
  meetingId: string;
  /** Stable session id; the pod mounts the agent as `agent_<sessionId>`. */
  sessionId: string;
  /** Optional override: pick video generator on the pod. */
  videoModel?: "wan" | "ltx";
  /** Identity key passed to ARACHNE IdentityBank. Defaults to `AVATAR_DEFAULT_KEY`. */
  avatarKey?: string;
  /** Override the candidate participant id (defaults to `candidate-<meetingId>`). */
  candidateUserId?: string;
  /** Display name for the avatar in Stream. */
  agentDisplayName?: string;
  /** OpenAI realtime instructions; if omitted we use a generic interview opener. */
  openaiInstructions?: string;
  /** Optional OpenAI realtime voice override (persisted per meeting). */
  openaiVoice?: string;
  /** Optional reference portrait URL for AI2V. Falls back to AVATAR_REFERENCE_IMAGE_URL. */
  referenceImageUrl?: string;
  /** Optional emotion tag. Falls back to AVATAR_DEFAULT_EMOTION. */
  emotion?: string;
  /** Optional LTX overrides (used when videoModel=ltx). */
  ltx?: Partial<{
    checkpoint: string;
    variant: string;
    width: number;
    height: number;
    num_frames: number;
    fps: number;
    steps: number;
    cfg: number;
    seed: number;
  }>;
}

export interface CreateAvatarSessionResponse {
  provider: "runpod" | "local";
  session_id: string;
  status: "starting" | "ready";
  agent_user_id: string;
}

const DEFAULT_INSTRUCTIONS =
  "You are an HR interviewer conducting a structured screening call in Russian. Speak naturally, ask one question at a time, and keep replies under 25 seconds.";

export class AvatarServiceUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "AvatarServiceUnavailableError";
  }
}

export class AvatarClient {
  private readonly baseUrl?: string;
  private readonly sharedToken?: string;
  private readonly streamApiKey?: string;
  private readonly streamApiSecret?: string;
  private readonly streamCallType: string;
  private readonly httpTimeoutMs: number;
  public readonly enabled: boolean;

  constructor() {
    this.enabled = env.AVATAR_ENABLED;
    this.baseUrl = env.AVATAR_POD_URL?.replace(/\/+$/, "");
    this.sharedToken = env.AVATAR_SHARED_TOKEN;
    this.streamApiKey = env.STREAM_API_KEY;
    this.streamApiSecret = env.STREAM_API_SECRET;
    this.streamCallType = env.STREAM_CALL_TYPE;
    this.httpTimeoutMs = env.AVATAR_HTTP_TIMEOUT_MS;
  }

  isConfigured(): boolean {
    return Boolean(
      this.enabled &&
        this.baseUrl &&
        this.sharedToken &&
        this.streamApiKey &&
        this.streamApiSecret
    );
  }

  /**
   * Asks the avatar pod to start a session and join the SFU call.
   * Caller is expected to fire-and-forget; failures are logged but do not
   * crash the meeting (the candidate can still talk to OpenAI realtime
   * directly via /realtime/session if needed).
   */
  async createSession(input: CreateAvatarSessionInput): Promise<CreateAvatarSessionResponse> {
    if (!this.isConfigured()) {
      throw new AvatarServiceUnavailableError(
        "Avatar service is not configured (AVATAR_ENABLED / AVATAR_POD_URL / AVATAR_SHARED_TOKEN / STREAM_API_KEY / STREAM_API_SECRET)"
      );
    }

    const agentUserId = `agent_${input.sessionId}`;
    const candidateUserId =
      input.candidateUserId ?? `candidate-${input.meetingId}`.replace(/[^a-zA-Z0-9_-]/g, "-");

    const agentUserToken = mintStreamUserToken({
      apiSecret: this.streamApiSecret as string,
      userId: agentUserId,
      validitySeconds: 60 * 60 * 4
    });

    const referenceImageUrl = input.referenceImageUrl ?? env.AVATAR_REFERENCE_IMAGE_URL;
    const resolvedVideoModel = input.videoModel ?? env.AVATAR_VIDEO_MODEL;
    const ltxDefaults = {
      checkpoint: env.AVATAR_LTX_CHECKPOINT,
      variant: env.AVATAR_LTX_VARIANT,
      width: env.AVATAR_LTX_WIDTH,
      height: env.AVATAR_LTX_HEIGHT,
      num_frames: env.AVATAR_LTX_NUM_FRAMES,
      fps: env.AVATAR_LTX_FPS,
      steps: env.AVATAR_LTX_STEPS,
      cfg: env.AVATAR_LTX_CFG,
      ...(typeof env.AVATAR_LTX_SEED === "number" ? { seed: env.AVATAR_LTX_SEED } : {})
    };
    const body = {
      meeting_id: input.meetingId,
      session_id: input.sessionId,
      avatar_key: input.avatarKey ?? env.AVATAR_DEFAULT_KEY,
      transport: "webrtc-sfu" as const,
      video_model: resolvedVideoModel,
      ...(resolvedVideoModel === "ltx" ? { ltx: { ...ltxDefaults, ...(input.ltx ?? {}) } } : {}),
      duplex_mode: env.AVATAR_DUPLEX_MODE,
      video_audio_source: env.AVATAR_VIDEO_AUDIO_SOURCE,
      speaker_hold_ms: env.AVATAR_SPEAKER_HOLD_MS,
      mic_vad_rms_threshold: env.AVATAR_MIC_VAD_RMS_THRESHOLD,
      mic_vad_silence_ms: env.AVATAR_MIC_VAD_SILENCE_MS,
      openai: {
        instructions: input.openaiInstructions ?? DEFAULT_INSTRUCTIONS,
        voice: input.openaiVoice?.trim() || env.OPENAI_REALTIME_VOICE,
        input_audio_format: "pcm16" as const,
        output_audio_format: "pcm16" as const
      },
      sfu: {
        call_type: this.streamCallType,
        call_id: input.meetingId,
        agent_user_id: agentUserId,
        agent_user_name: input.agentDisplayName ?? "HR ассистент",
        agent_user_token: agentUserToken,
        candidate_user_id: candidateUserId
      },
      arachne: {
        prompt: "A professional HR interviewer speaking warmly to camera, neutral office background.",
        resolution: "480p" as const,
        num_frames: 25,
        num_inference_steps: 8,
        text_guidance_scale: 4.0,
        audio_guidance_scale: 4.0
      },
      ...(referenceImageUrl ? { reference_image: { url: referenceImageUrl } } : {}),
      emotion: input.emotion ?? env.AVATAR_DEFAULT_EMOTION
    };

    const url = `${this.baseUrl}/sessions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.httpTimeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.sharedToken}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const text = await response.text();
      if (!response.ok) {
        logger.error(
          {
            url,
            status: response.status,
            body: text.slice(0, 1000),
            meetingId: input.meetingId,
            sessionId: input.sessionId
          },
          "avatar pod create-session failed"
        );
        throw new AvatarServiceUnavailableError(
          `Avatar pod returned ${response.status}: ${text.slice(0, 200)}`
        );
      }

      let parsed: CreateAvatarSessionResponse;
      try {
        parsed = JSON.parse(text) as CreateAvatarSessionResponse;
      } catch (err) {
        throw new AvatarServiceUnavailableError(
          "Avatar pod returned non-JSON success body",
          err
        );
      }

      logger.info(
        {
          meetingId: input.meetingId,
          sessionId: input.sessionId,
          agentUserId: parsed.agent_user_id,
          status: parsed.status,
          provider: parsed.provider
        },
        "avatar pod session created"
      );
      return parsed;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new AvatarServiceUnavailableError(
          `Avatar pod create-session timed out after ${this.httpTimeoutMs}ms`,
          err
        );
      }
      if (err instanceof AvatarServiceUnavailableError) {
        throw err;
      }
      throw new AvatarServiceUnavailableError(
        `Avatar pod create-session network error: ${(err as Error).message}`,
        err
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Tears down a session on the pod. Best-effort — errors are swallowed (logged)
   * because by the time we call this the meeting is already terminal anyway.
   */
  async deleteSession(sessionId: string): Promise<void> {
    if (!this.isConfigured()) {
      return;
    }
    const url = `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.httpTimeoutMs);
    try {
      const response = await fetch(url, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this.sharedToken}`
        },
        signal: controller.signal
      });
      if (!response.ok && response.status !== 404) {
        const text = await response.text().catch(() => "");
        logger.warn(
          { url, status: response.status, body: text.slice(0, 500), sessionId },
          "avatar pod delete-session non-2xx"
        );
      } else {
        logger.info({ sessionId }, "avatar pod session deleted");
      }
    } catch (err) {
      logger.warn(
        { sessionId, err: (err as Error).message },
        "avatar pod delete-session failed"
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async postSessionCommand(
    sessionId: string,
    input: { type: "duplex_mode.set" | "video_audio_source.set" | "speaker.set" | "response.cancel"; payload?: Record<string, unknown> }
  ): Promise<void> {
    if (!this.isConfigured()) {
      throw new AvatarServiceUnavailableError(
        "Avatar service is not configured (AVATAR_ENABLED / AVATAR_POD_URL / AVATAR_SHARED_TOKEN / STREAM_API_KEY / STREAM_API_SECRET)"
      );
    }
    const url = `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/commands`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.httpTimeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.sharedToken}`
        },
        body: JSON.stringify({ type: input.type, payload: input.payload ?? {} }),
        signal: controller.signal
      });
      const text = await response.text().catch(() => "");
      if (!response.ok) {
        logger.warn({ url, status: response.status, body: text.slice(0, 500), sessionId, type: input.type }, "avatar pod command failed");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ sessionId, type: input.type, err: message }, "avatar pod command network error");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Verifies the bearer token a pod sent on /avatar/events callback. */
  verifyCallbackToken(headerValue: string | undefined): boolean {
    if (!this.sharedToken) return false;
    if (!headerValue) return false;
    const match = headerValue.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    return match[1] === this.sharedToken;
  }
}
