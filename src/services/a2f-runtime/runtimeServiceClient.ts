import type {
  AudioChunk,
  RuntimeFrameSubscriber,
  RuntimeIngestResult,
  RuntimeSessionConfig,
  SessionRuntimeStats
} from "./contracts";
import { A2FRuntimeService } from "./a2fRuntimeService";

export interface A2FRuntimeClient {
  startSession(config: RuntimeSessionConfig): void;
  stopSession(meetingId: string): void;
  ingestChunk(meetingId: string, chunk: AudioChunk): RuntimeIngestResult;
  subscribe(meetingId: string, subscriber: RuntimeFrameSubscriber): () => void;
  getStats(meetingId: string): SessionRuntimeStats | null;
  listStats(): SessionRuntimeStats[];
}

export class InProcessA2FRuntimeClient implements A2FRuntimeClient {
  constructor(private readonly service: A2FRuntimeService) {}

  startSession(config: RuntimeSessionConfig): void {
    this.service.startSession(config);
  }

  stopSession(meetingId: string): void {
    this.service.stopSession(meetingId);
  }

  ingestChunk(meetingId: string, chunk: AudioChunk): RuntimeIngestResult {
    return this.service.ingestChunk(meetingId, chunk);
  }

  subscribe(meetingId: string, subscriber: RuntimeFrameSubscriber): () => void {
    return this.service.subscribe(meetingId, subscriber);
  }

  getStats(meetingId: string): SessionRuntimeStats | null {
    return this.service.getStats(meetingId);
  }

  listStats(): SessionRuntimeStats[] {
    return this.service.listStats();
  }
}

