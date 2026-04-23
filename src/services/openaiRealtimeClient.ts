import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import { logger } from "../logging/logger";
import type {
  ClientSecretResult,
  RealtimeCallRequest,
  RealtimeCallResult,
  SessionConfig
} from "../types/realtime";

function buildSessionConfig(overrides?: Partial<SessionConfig>): SessionConfig {
  return {
    type: "realtime",
    model: env.OPENAI_REALTIME_MODEL,
    turn_detection: {
      type: env.OPENAI_TURN_DETECTION_TYPE,
      threshold: env.OPENAI_TURN_DETECTION_THRESHOLD,
      prefix_padding_ms: env.OPENAI_TURN_DETECTION_PREFIX_PADDING_MS,
      silence_duration_ms: env.OPENAI_TURN_DETECTION_SILENCE_DURATION_MS
    },
    audio: {
      input: {
        format: {
          type: "audio/pcm",
          rate: 24000
        }
      },
      output: {
        format: {
          type: "audio/pcm",
          rate: 24000
        },
        voice: env.OPENAI_REALTIME_VOICE
      }
    },
    ...overrides
  };
}

function normalizeSdp(input: string): string {
  const normalized = input.replace(/\r?\n/g, "\r\n").trim();
  return `${normalized}\r\n`;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), env.OPENAI_HTTP_TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, signal: abortController.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new HttpError(504, "Timed out while calling OpenAI Realtime API");
    }
    throw new HttpError(502, "Failed to call OpenAI Realtime API");
  } finally {
    clearTimeout(timeout);
  }
}

async function parseJsonOrThrow(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new HttpError(502, "OpenAI returned non-JSON response");
  }
}

async function parseSdpAnswerOrThrow(response: Response): Promise<string> {
  const text = (await response.text()).trim();
  if (!text) {
    throw new HttpError(502, "OpenAI realtime response body is empty");
  }
  if (!text.startsWith("v=0")) {
    throw new HttpError(502, "OpenAI realtime returned invalid SDP answer");
  }
  return normalizeSdp(text);
}

export class OpenAIRealtimeClient {
  private readonly authHeaders: Record<string, string>;
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = env.OPENAI_BASE_URL;
    this.authHeaders = {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`
    };
    logger.info(
      {
        baseUrl: this.baseUrl,
        model: env.OPENAI_REALTIME_MODEL,
        voice: env.OPENAI_REALTIME_VOICE,
        turnDetection: {
          type: env.OPENAI_TURN_DETECTION_TYPE,
          threshold: env.OPENAI_TURN_DETECTION_THRESHOLD,
          prefixPaddingMs: env.OPENAI_TURN_DETECTION_PREFIX_PADDING_MS,
          silenceDurationMs: env.OPENAI_TURN_DETECTION_SILENCE_DURATION_MS
        }
      },
      "openai realtime client configured"
    );
  }

  getDefaultSessionConfig(overrides?: Partial<SessionConfig>): SessionConfig {
    return buildSessionConfig(overrides);
  }

  async createRealtimeCall(input: RealtimeCallRequest): Promise<RealtimeCallResult> {
    // GA spec (https://platform.openai.com/docs/guides/realtime-webrtc):
    //   POST /v1/realtime/calls with multipart/form-data { sdp, session }
    // Where `session` is the JSON session config (type, model, audio, instructions, ...).
    // Sending raw application/sdp without the session field works for SDP negotiation
    // but leaves voice/audio/turn_detection at server defaults and the agent may not
    // produce audio output at all.
    const callsUrl = `${this.baseUrl}/realtime/calls`;
    const sessionConfig = this.getDefaultSessionConfig(input.session);
    const formData = new FormData();
    formData.set("sdp", input.sdp);
    formData.set("session", JSON.stringify(sessionConfig));

    const response = await fetchWithTimeout(callsUrl, {
      method: "POST",
      headers: {
        // Don't set Content-Type — fetch sets multipart boundary automatically.
        ...this.authHeaders,
        Accept: "application/sdp"
      },
      body: formData
    });

    if (!response.ok) {
      const errorBody = await parseJsonOrThrow(response);
      logger.error({ status: response.status, errorBody }, "openai realtime call failed");
      throw new HttpError(response.status, "OpenAI realtime call failed", errorBody);
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("application/sdp") || contentType.includes("text/plain")) {
      const answerSdp = await parseSdpAnswerOrThrow(response);
      return { answerSdp };
    }

    const payload = await parseJsonOrThrow(response);
    const answerSdp = this.extractAnswerSdp(payload);
    const remoteCallId = typeof payload.id === "string" ? payload.id : undefined;
    return { answerSdp, remoteCallId };
  }

  async createEphemeralClientSecret(session?: Partial<SessionConfig>): Promise<ClientSecretResult> {
    const response = await fetchWithTimeout(`${this.baseUrl}/realtime/client_secrets`, {
      method: "POST",
      headers: {
        ...this.authHeaders,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        session: this.getDefaultSessionConfig(session)
      })
    });

    if (!response.ok) {
      const errorBody = await parseJsonOrThrow(response);
      logger.error({ status: response.status, errorBody }, "openai client secret failed");
      throw new HttpError(response.status, "OpenAI client secret request failed", errorBody);
    }

    const payload = await parseJsonOrThrow(response);
    const secretObject = payload.client_secret as Record<string, unknown> | string | undefined;
    const altSecretObject = payload.secret as Record<string, unknown> | undefined;
    const value =
      (typeof secretObject === "object" && secretObject !== null && typeof secretObject.value === "string"
        ? secretObject.value
        : undefined) ??
      (typeof secretObject === "string" ? secretObject : undefined) ??
      (typeof altSecretObject?.value === "string" ? altSecretObject.value : undefined) ??
      (typeof payload.value === "string" ? payload.value : undefined);

    if (!value) {
      throw new HttpError(502, "OpenAI client secret response missing value");
    }

    const expiresAt =
      (typeof secretObject === "object" &&
      secretObject !== null &&
      typeof secretObject.expires_at === "number"
        ? secretObject.expires_at
        : undefined) ??
      (typeof altSecretObject?.expires_at === "number" ? altSecretObject.expires_at : undefined) ??
      (typeof payload.expires_at === "number" ? payload.expires_at : undefined);

    return { value, expiresAt, raw: payload };
  }

  private extractAnswerSdp(payload: Record<string, unknown>): string {
    const directAnswer = payload.answer;
    if (typeof directAnswer === "string" && directAnswer.trim().length > 0) {
      return normalizeSdp(directAnswer);
    }

    if (
      typeof directAnswer === "object" &&
      directAnswer !== null &&
      "sdp" in directAnswer &&
      typeof (directAnswer as Record<string, unknown>).sdp === "string"
    ) {
      return normalizeSdp((directAnswer as Record<string, string>).sdp);
    }

    if (typeof payload.sdp === "string" && payload.sdp.trim().length > 0) {
      return normalizeSdp(payload.sdp);
    }

    throw new HttpError(502, "OpenAI realtime response missing SDP answer");
  }
}
