import { createHmac } from "node:crypto";

export class WebhookSigner {
  constructor(private readonly secret: string) {}

  sign(timestampMs: number, payloadBody: string): string {
    const signedPayload = `${timestampMs}.${payloadBody}`;
    const digest = createHmac("sha256", this.secret).update(signedPayload).digest("hex");
    return `sha256=${digest}`;
  }
}
