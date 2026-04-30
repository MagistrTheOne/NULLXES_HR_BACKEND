import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "../config/env";

function safeId(raw: string): string {
  return raw.trim().replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 180) || "unknown";
}

function extensionForContentType(contentType: string): string {
  const lower = contentType.toLowerCase();
  if (lower.includes("webm")) return "webm";
  if (lower.includes("ogg")) return "ogg";
  if (lower.includes("wav")) return "wav";
  if (lower.includes("mpeg") || lower.includes("mp3")) return "mp3";
  if (lower.includes("mp4") || lower.includes("m4a")) return "m4a";
  return "bin";
}

export type SavedAssistantAudio = {
  absolutePath: string;
  filename: string;
  publicUrlPath: string;
  bytes: number;
  contentType: string;
};

export async function saveAssistantAudioArtifact(params: {
  meetingId: string;
  bytes: Buffer;
  contentType: string;
}): Promise<SavedAssistantAudio> {
  const meetingId = safeId(params.meetingId);
  const contentType = (params.contentType || "application/octet-stream").trim();
  const ext = extensionForContentType(contentType);
  const filename = `${meetingId}.assistant-audio.${Date.now()}.${ext}`;

  await fs.mkdir(env.ARTIFACTS_DIR, { recursive: true });
  const absolutePath = path.join(env.ARTIFACTS_DIR, filename);
  await fs.writeFile(absolutePath, params.bytes);

  return {
    absolutePath,
    filename,
    publicUrlPath: `/artifacts/${encodeURIComponent(filename)}`,
    bytes: params.bytes.byteLength,
    contentType
  };
}

