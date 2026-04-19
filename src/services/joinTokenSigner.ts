import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal JWT-like signed token for candidate / spectator join links (M3).
 *
 * Format: base64url(headerJson) + "." + base64url(payloadJson) + "." + base64url(hmacSha256)
 *
 * Why not a full JWT library: we already use no JWT deps, the surface is small,
 * and we want full control over what fields we accept. This is symmetric (HS256)
 * because issuer == verifier (gateway).
 */

export type JoinTokenRole = "candidate" | "spectator";

export interface JoinTokenClaims {
  /** JobAI interview id this token grants access to. */
  jobAiId: number;
  /** Which surface the token grants access to. */
  role: JoinTokenRole;
  /** Unique token id (UUID v4). Used for revocation lookups and audit. */
  jti: string;
  /** Optional override for displayed candidate / spectator name. */
  displayName?: string;
  /** Issued-at, ms since epoch. */
  iat: number;
  /** Expires-at, ms since epoch. */
  exp: number;
}

export type JoinTokenVerifyError =
  | { kind: "malformed"; reason: string }
  | { kind: "invalid_signature" }
  | { kind: "expired"; expiredAtMs: number };

export class JoinTokenError extends Error {
  constructor(public readonly detail: JoinTokenVerifyError) {
    super(detail.kind);
    this.name = "JoinTokenError";
  }
}

const HEADER = { alg: "HS256", typ: "NJL+1" } as const; // NULLXES Join Link v1

function b64urlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class JoinTokenSigner {
  constructor(private readonly secret: string) {
    if (!secret || secret.length < 32) {
      throw new Error("JoinTokenSigner: secret must be at least 32 chars");
    }
  }

  sign(claims: JoinTokenClaims): string {
    const header = b64urlEncode(JSON.stringify(HEADER));
    const payload = b64urlEncode(JSON.stringify(claims));
    const signature = this.computeSignature(`${header}.${payload}`);
    return `${header}.${payload}.${signature}`;
  }

  /**
   * Verifies token signature, format, and expiry.
   * Throws `JoinTokenError` with structured `detail` on failure.
   * Revocation is checked separately by the caller (against the JoinTokenStore).
   */
  verify(token: string, nowMs: number = Date.now()): JoinTokenClaims {
    if (typeof token !== "string" || token.length === 0) {
      throw new JoinTokenError({ kind: "malformed", reason: "empty_token" });
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new JoinTokenError({ kind: "malformed", reason: "expected_three_segments" });
    }
    const [headerB64, payloadB64, sigB64] = parts;
    if (!headerB64 || !payloadB64 || !sigB64) {
      throw new JoinTokenError({ kind: "malformed", reason: "empty_segment" });
    }

    const expectedSig = this.computeSignature(`${headerB64}.${payloadB64}`);
    if (!safeEqual(b64urlDecode(sigB64), b64urlDecode(expectedSig))) {
      throw new JoinTokenError({ kind: "invalid_signature" });
    }

    let header: { alg?: unknown; typ?: unknown };
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(b64urlDecode(headerB64).toString("utf8")) as typeof header;
      payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as Record<string, unknown>;
    } catch (err) {
      throw new JoinTokenError({
        kind: "malformed",
        reason: `json_parse_failed: ${(err as Error).message}`
      });
    }

    if (header.alg !== HEADER.alg || header.typ !== HEADER.typ) {
      throw new JoinTokenError({ kind: "malformed", reason: "header_mismatch" });
    }

    const claims = this.parseClaims(payload);
    if (claims.exp <= nowMs) {
      throw new JoinTokenError({ kind: "expired", expiredAtMs: claims.exp });
    }
    return claims;
  }

  private computeSignature(signingInput: string): string {
    const digest = createHmac("sha256", this.secret).update(signingInput, "utf8").digest();
    return b64urlEncode(digest);
  }

  private parseClaims(payload: Record<string, unknown>): JoinTokenClaims {
    const jobAiId = payload.jobAiId;
    const role = payload.role;
    const jti = payload.jti;
    const iat = payload.iat;
    const exp = payload.exp;
    const displayName = payload.displayName;

    if (typeof jobAiId !== "number" || !Number.isInteger(jobAiId) || jobAiId <= 0) {
      throw new JoinTokenError({ kind: "malformed", reason: "invalid_jobAiId" });
    }
    if (role !== "candidate" && role !== "spectator") {
      throw new JoinTokenError({ kind: "malformed", reason: "invalid_role" });
    }
    if (typeof jti !== "string" || jti.length === 0) {
      throw new JoinTokenError({ kind: "malformed", reason: "invalid_jti" });
    }
    if (typeof iat !== "number" || !Number.isFinite(iat) || iat <= 0) {
      throw new JoinTokenError({ kind: "malformed", reason: "invalid_iat" });
    }
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= iat) {
      throw new JoinTokenError({ kind: "malformed", reason: "invalid_exp" });
    }
    if (displayName !== undefined && typeof displayName !== "string") {
      throw new JoinTokenError({ kind: "malformed", reason: "invalid_displayName" });
    }
    return {
      jobAiId,
      role,
      jti,
      iat,
      exp,
      ...(typeof displayName === "string" && displayName.length > 0 ? { displayName } : {})
    };
  }
}
