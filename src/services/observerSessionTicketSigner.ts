import { createHmac, timingSafeEqual } from "node:crypto";

export interface ObserverSessionTicketClaims {
  jobAiId: number;
  meetingId: string;
  role: "spectator";
  jti: string;
  iat: number;
  exp: number;
}

export type ObserverSessionTicketVerifyError =
  | { kind: "malformed"; reason: string }
  | { kind: "invalid_signature" }
  | { kind: "expired"; expiredAtMs: number };

export class ObserverSessionTicketError extends Error {
  constructor(public readonly detail: ObserverSessionTicketVerifyError) {
    super(detail.kind);
    this.name = "ObserverSessionTicketError";
  }
}

const HEADER = { alg: "HS256", typ: "NOBS+1" } as const;

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

export class ObserverSessionTicketSigner {
  constructor(private readonly secret: string) {
    if (!secret || secret.length < 32) {
      throw new Error("ObserverSessionTicketSigner: secret must be at least 32 chars");
    }
  }

  sign(claims: ObserverSessionTicketClaims): string {
    const header = b64urlEncode(JSON.stringify(HEADER));
    const payload = b64urlEncode(JSON.stringify(claims));
    const signature = this.computeSignature(`${header}.${payload}`);
    return `${header}.${payload}.${signature}`;
  }

  verify(token: string, nowMs: number = Date.now()): ObserverSessionTicketClaims {
    if (typeof token !== "string" || token.length === 0) {
      throw new ObserverSessionTicketError({ kind: "malformed", reason: "empty_token" });
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new ObserverSessionTicketError({ kind: "malformed", reason: "expected_three_segments" });
    }
    const [headerB64, payloadB64, sigB64] = parts;
    if (!headerB64 || !payloadB64 || !sigB64) {
      throw new ObserverSessionTicketError({ kind: "malformed", reason: "empty_segment" });
    }

    const expectedSig = this.computeSignature(`${headerB64}.${payloadB64}`);
    if (!safeEqual(b64urlDecode(sigB64), b64urlDecode(expectedSig))) {
      throw new ObserverSessionTicketError({ kind: "invalid_signature" });
    }

    let header: { alg?: unknown; typ?: unknown };
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(b64urlDecode(headerB64).toString("utf8")) as typeof header;
      payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as Record<string, unknown>;
    } catch (err) {
      throw new ObserverSessionTicketError({
        kind: "malformed",
        reason: `json_parse_failed: ${(err as Error).message}`
      });
    }

    if (header.alg !== HEADER.alg || header.typ !== HEADER.typ) {
      throw new ObserverSessionTicketError({ kind: "malformed", reason: "header_mismatch" });
    }

    const claims = this.parseClaims(payload);
    if (claims.exp <= nowMs) {
      throw new ObserverSessionTicketError({ kind: "expired", expiredAtMs: claims.exp });
    }
    return claims;
  }

  private computeSignature(signingInput: string): string {
    const digest = createHmac("sha256", this.secret).update(signingInput, "utf8").digest();
    return b64urlEncode(digest);
  }

  private parseClaims(payload: Record<string, unknown>): ObserverSessionTicketClaims {
    const jobAiId = payload.jobAiId;
    const meetingId = payload.meetingId;
    const role = payload.role;
    const jti = payload.jti;
    const iat = payload.iat;
    const exp = payload.exp;

    if (typeof jobAiId !== "number" || !Number.isInteger(jobAiId) || jobAiId <= 0) {
      throw new ObserverSessionTicketError({ kind: "malformed", reason: "invalid_jobAiId" });
    }
    if (typeof meetingId !== "string" || meetingId.length === 0) {
      throw new ObserverSessionTicketError({ kind: "malformed", reason: "invalid_meetingId" });
    }
    if (role !== "spectator") {
      throw new ObserverSessionTicketError({ kind: "malformed", reason: "invalid_role" });
    }
    if (typeof jti !== "string" || jti.length === 0) {
      throw new ObserverSessionTicketError({ kind: "malformed", reason: "invalid_jti" });
    }
    if (typeof iat !== "number" || !Number.isFinite(iat) || iat <= 0) {
      throw new ObserverSessionTicketError({ kind: "malformed", reason: "invalid_iat" });
    }
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= iat) {
      throw new ObserverSessionTicketError({ kind: "malformed", reason: "invalid_exp" });
    }
    return { jobAiId, meetingId, role, jti, iat, exp };
  }
}

