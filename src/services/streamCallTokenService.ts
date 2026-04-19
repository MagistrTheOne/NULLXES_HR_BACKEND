import { createHmac } from "node:crypto";

/**
 * Mints a Stream user token (JWT HS256 over the Stream API secret).
 * Mirrors `StreamClient(apiKey, secret).generateUserToken({user_id, validity_in_seconds})`
 * from `@stream-io/node-sdk` so we don't need to pull the SDK into the gateway.
 *
 * The token is consumed by:
 * - the avatar pod (joining as `agent_<sessionId>`)
 * - the frontend (`/api/stream/token` already uses the SDK on its own; we mirror only
 *   what the pod needs server-to-server).
 */

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export interface StreamTokenInput {
  apiSecret: string;
  userId: string;
  /** Token lifetime in seconds. Defaults to 1 hour. */
  validitySeconds?: number;
  /** Override the issued-at timestamp (mostly for tests). */
  nowSeconds?: number;
}

export function mintStreamUserToken(input: StreamTokenInput): string {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = now + (input.validitySeconds ?? 3600);

  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    user_id: input.userId,
    iat: now,
    exp
  };

  const headerSegment = base64UrlEncode(JSON.stringify(header));
  const payloadSegment = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerSegment}.${payloadSegment}`;

  const signature = createHmac("sha256", input.apiSecret)
    .update(signingInput)
    .digest();

  return `${signingInput}.${base64UrlEncode(signature)}`;
}
