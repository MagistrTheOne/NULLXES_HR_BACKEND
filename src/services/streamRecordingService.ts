import { mintStreamAdminToken } from "./streamCallTokenService";

type RecordingLifecycleState =
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "stopped"
  | "ready"
  | "failed";

export type StreamRecordingAsset = {
  id: string;
  filename?: string;
  url?: string;
  sizeBytes?: number;
  startedAt?: string;
  endedAt?: string;
  codec?: string;
  container?: string;
  trackType?: string;
};

export type StreamRecordingSnapshot = {
  state: RecordingLifecycleState;
  callType: string;
  callId: string;
  activeRecordingId?: string;
  assets: StreamRecordingAsset[];
  providerRaw?: Record<string, unknown>;
};

export class StreamRecordingStateError extends Error {
  readonly code: "not_recording" | "already_recording" | "processing" | "not_found";
  readonly status: number;

  constructor(code: StreamRecordingStateError["code"], status: number, message: string) {
    super(message);
    this.name = "StreamRecordingStateError";
    this.code = code;
    this.status = status;
  }
}

export interface StreamRecordingServiceInput {
  apiKey: string;
  apiSecret: string;
  callType: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function toAsset(item: Record<string, unknown>): StreamRecordingAsset {
  const id =
    (typeof item.id === "string" && item.id) ||
    (typeof item.recording_id === "string" && item.recording_id) ||
    (typeof item.session_id === "string" && item.session_id) ||
    "unknown";
  return {
    id,
    filename: typeof item.filename === "string" ? item.filename : undefined,
    url:
      (typeof item.url === "string" && item.url) ||
      (typeof item.mp4_url === "string" && item.mp4_url) ||
      (typeof item.download_url === "string" && item.download_url) ||
      undefined,
    sizeBytes: typeof item.size === "number" ? item.size : undefined,
    startedAt: typeof item.start_time === "string" ? item.start_time : undefined,
    endedAt: typeof item.end_time === "string" ? item.end_time : undefined,
    codec: typeof item.codec === "string" ? item.codec : undefined,
    container: typeof item.container === "string" ? item.container : undefined,
    trackType: typeof item.track_type === "string" ? item.track_type : undefined
  };
}

export class StreamRecordingService {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly callType: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(input: StreamRecordingServiceInput) {
    this.apiKey = input.apiKey;
    this.apiSecret = input.apiSecret;
    this.callType = input.callType;
    this.baseUrl = (input.baseUrl ?? "https://video.stream-io-api.com").replace(/\/+$/, "");
    this.fetchImpl = input.fetchImpl ?? fetch;
    this.timeoutMs = input.timeoutMs ?? 10_000;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiSecret);
  }

  async start(callId: string): Promise<StreamRecordingSnapshot> {
    try {
      await this.adminRequest("POST", `/api/v2/video/call/${encodeURIComponent(this.callType)}/${encodeURIComponent(callId)}/start_recording`);
    } catch (error) {
      if (
        error instanceof StreamRecordingStateError &&
        (error.code === "already_recording" || error.code === "processing")
      ) {
        return this.getSnapshot(callId);
      }
      throw error;
    }
    return this.getSnapshot(callId);
  }

  async stop(callId: string): Promise<StreamRecordingSnapshot> {
    try {
      await this.adminRequest("POST", `/api/v2/video/call/${encodeURIComponent(this.callType)}/${encodeURIComponent(callId)}/stop_recording`);
    } catch (error) {
      if (
        error instanceof StreamRecordingStateError &&
        (error.code === "not_recording" || error.code === "processing")
      ) {
        return this.getSnapshot(callId);
      }
      throw error;
    }
    return this.getSnapshot(callId);
  }

  async getSnapshot(callId: string): Promise<StreamRecordingSnapshot> {
    const [callPayload, recordingsPayload] = await Promise.all([
      this.adminRequest("GET", `/api/v2/video/call/${encodeURIComponent(this.callType)}/${encodeURIComponent(callId)}`),
      this.adminRequest("GET", `/api/v2/video/call/${encodeURIComponent(this.callType)}/${encodeURIComponent(callId)}/recordings`).catch(
        () => ({})
      )
    ]);

    const callRecord = asRecord(callPayload);
    const callData = asRecord(callRecord?.call) ?? callRecord;
    const recording = asRecord(callData?.recording);
    const recState = typeof recording?.state === "string" ? recording.state : undefined;
    const activeRecordingId =
      typeof recording?.recording_id === "string"
        ? recording.recording_id
        : typeof recording?.id === "string"
          ? recording.id
          : undefined;

    const recPayload = asRecord(recordingsPayload);
    const fromItems = Array.isArray(recPayload?.recordings) ? recPayload.recordings : [];
    const fromCall =
      Array.isArray(callData?.recordings) ? (callData.recordings as unknown[]) : Array.isArray(recording?.outputs) ? recording.outputs : [];
    const combined = [...fromItems, ...fromCall]
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map(toAsset);

    const state = this.resolveState(recState, combined, activeRecordingId);

    return {
      state,
      callType: this.callType,
      callId,
      activeRecordingId,
      assets: combined,
      providerRaw: (callRecord ?? {}) as Record<string, unknown>
    };
  }

  private resolveState(
    providerState: string | undefined,
    assets: StreamRecordingAsset[],
    activeRecordingId?: string
  ): RecordingLifecycleState {
    const normalized = providerState?.toLowerCase();
    if (normalized === "recording" || normalized === "active") return "recording";
    if (normalized === "starting") return "starting";
    if (normalized === "stopping") return "stopping";
    if (normalized === "stopped") return assets.length > 0 ? "ready" : "stopped";
    if (normalized === "failed" || normalized === "error") return "failed";
    if (activeRecordingId) return "recording";
    if (assets.length > 0) return "ready";
    return "idle";
  }

  private classifyError(status: number, body: string): StreamRecordingStateError | null {
    const text = body.toLowerCase();
    if (status === 404) {
      return new StreamRecordingStateError("not_found", status, "Stream call not found");
    }
    if (text.includes("already recording") || text.includes("recording already in progress")) {
      return new StreamRecordingStateError("already_recording", status, "Recording already started");
    }
    if (text.includes("not recording") || text.includes("no active recording")) {
      return new StreamRecordingStateError("not_recording", status, "Recording is not active");
    }
    if (text.includes("processing") || text.includes("not ready") || text.includes("egress")) {
      return new StreamRecordingStateError("processing", status, "Recording is being processed");
    }
    return null;
  }

  private async adminRequest(method: "GET" | "POST", path: string): Promise<unknown> {
    const adminToken = mintStreamAdminToken({ apiSecret: this.apiSecret });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = `${this.baseUrl}${path}?api_key=${encodeURIComponent(this.apiKey)}`;
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: adminToken,
          "stream-auth-type": "jwt",
          "Content-Type": "application/json"
        },
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        const classified = this.classifyError(response.status, text);
        if (classified) {
          throw classified;
        }
        throw new Error(`Stream recording request failed: ${response.status} ${text.slice(0, 240)}`);
      }
      if (!text.trim()) {
        return {};
      }
      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

