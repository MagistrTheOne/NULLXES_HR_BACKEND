import type { RuntimeFrameEnvelope } from "../contracts";

export interface ProtobufEncoder {
  encode(frame: RuntimeFrameEnvelope): Uint8Array;
}

/**
 * Pluggable protobuf encoder hook.
 * Uses compact JSON bytes by default so WS transport can be switched to binary
 * without changing caller flow. Replace with real protobuf wire encoder later.
 */
export class JsonBinaryFrameEncoder implements ProtobufEncoder {
  encode(frame: RuntimeFrameEnvelope): Uint8Array {
    return Buffer.from(JSON.stringify(frame), "utf8");
  }
}

