import { logger } from "../logging/logger";
import { mintStreamAdminToken } from "./streamCallTokenService";

/**
 * Server-side provisioner for Stream Video.
 *
 * Stream's REST `JoinCall` endpoint requires both the call and the joining
 * user to already exist in the project. The frontend SDK does this implicitly
 * via `connectUser()` (which opens a WebSocket and auto-upserts), but the
 * avatar pod talks raw REST and therefore needs us to pre-provision:
 *
 * 1. **Upsert** the agent user (and optionally the candidate) so Stream
 *    accepts the JWT we minted for them.
 * 2. **GetOrCreate** the call so it exists when the pod tries to join, and
 *    so the agent is registered as a member.
 *
 * Both operations are idempotent on Stream's side, so re-running is safe.
 */

export interface StreamProvisionerInput {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ProvisionAgentInput {
  callType: string;
  callId: string;
  agentUserId: string;
  agentDisplayName?: string;
  candidateUserId?: string;
  candidateDisplayName?: string;
}

export class StreamProvisioner {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(input: StreamProvisionerInput) {
    this.apiKey = input.apiKey;
    this.apiSecret = input.apiSecret;
    this.baseUrl = (input.baseUrl ?? "https://video.stream-io-api.com").replace(/\/+$/, "");
    this.fetchImpl = input.fetchImpl ?? fetch;
    this.timeoutMs = input.timeoutMs ?? 10_000;
  }

  /** Upserts users + creates the call + adds the members in one go. */
  async provisionAgentForCall(input: ProvisionAgentInput): Promise<void> {
    const userIds: Array<{ id: string; name?: string }> = [
      { id: input.agentUserId, name: input.agentDisplayName ?? "HR ассистент" }
    ];
    if (input.candidateUserId) {
      userIds.push({
        id: input.candidateUserId,
        name: input.candidateDisplayName ?? "Candidate"
      });
    }

    await this.upsertUsers(userIds);
    await this.getOrCreateCall(
      input.callType,
      input.callId,
      input.agentUserId,
      userIds.map((u) => u.id)
    );
  }

  /**
   * Upsert users via the unified Stream user store. Path matches what
   * `@stream-io/node-sdk` uses internally for `chat.upsertUsers`.
   */
  async upsertUsers(users: Array<{ id: string; name?: string; role?: string }>): Promise<void> {
    if (users.length === 0) return;
    const usersMap: Record<string, Record<string, unknown>> = {};
    for (const u of users) {
      usersMap[u.id] = { id: u.id, role: u.role ?? "user" };
      if (u.name) usersMap[u.id].name = u.name;
    }
    const url = `${this.baseUrl}/api/v2/users?api_key=${encodeURIComponent(this.apiKey)}`;
    await this.adminPost(url, { users: usersMap }, "upsertUsers");
  }

  /**
   * Create (or retrieve) a Stream Video call and register members.
   *
   * NB: `created_by_id` MUST be a user that already exists — that's why
   * `upsertUsers` runs first.
   */
  async getOrCreateCall(
    callType: string,
    callId: string,
    createdById: string,
    memberIds: string[]
  ): Promise<void> {
    const url = `${this.baseUrl}/api/v2/video/call/${encodeURIComponent(callType)}/${encodeURIComponent(callId)}?api_key=${encodeURIComponent(this.apiKey)}`;
    const body = {
      data: {
        created_by_id: createdById,
        members: memberIds.map((id) => ({ user_id: id, role: "user" }))
      }
    };
    await this.adminPost(url, body, "getOrCreateCall");
  }

  private async adminPost(url: string, body: unknown, opLabel: string): Promise<void> {
    const adminToken = mintStreamAdminToken({ apiSecret: this.apiSecret });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: adminToken,
          "stream-auth-type": "jwt"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await res.text();
      if (!res.ok) {
        logger.error(
          { op: opLabel, url, status: res.status, body: text.slice(0, 500) },
          "stream provisioner request failed"
        );
        throw new Error(
          `Stream ${opLabel} failed: ${res.status} ${text.slice(0, 200)}`
        );
      }
      logger.debug({ op: opLabel, status: res.status }, "stream provisioner ok");
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`Stream ${opLabel} timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
