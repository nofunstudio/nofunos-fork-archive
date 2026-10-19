// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac or timingSafeEqual.
import * as NodeCrypto from "node:crypto";

import type { ScheduledTaskWebhookSignature } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Constant-time string comparison that does not leak length through timing. */
export function constantTimeEquals(a: string, b: string): boolean {
  const digestA = NodeCrypto.createHash("sha256").update(a).digest();
  const digestB = NodeCrypto.createHash("sha256").update(b).digest();
  return NodeCrypto.timingSafeEqual(digestA, digestB);
}

/**
 * Checks the selected signing protocol over the exact request body bytes.
 * Standard Webhooks callers supply the current Effect Clock time; no wall clock
 * is read here, so replay-window checks are deterministic.
 */
export function verifyWebhookSignature(input: {
  readonly signature: ScheduledTaskWebhookSignature;
  readonly secret: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly nowMillis?: number;
}): boolean {
  if (input.signature.scheme === "standard-webhooks") {
    const id = input.headers["webhook-id"];
    const timestamp = input.headers["webhook-timestamp"];
    const signatures = input.headers["webhook-signature"];
    if (!id || timestamp === undefined || signatures === undefined || !/^\d+$/.test(timestamp)) {
      return false;
    }
    const seconds = Number(timestamp);
    if (
      !Number.isSafeInteger(seconds) ||
      input.nowMillis === undefined ||
      !Number.isFinite(input.nowMillis) ||
      Math.abs(input.nowMillis - seconds * 1_000) > 300_000
    ) {
      return false;
    }
    if (!input.secret.startsWith("whsec_")) return false;
    const encodedKey = input.secret.slice("whsec_".length);
    const key = Buffer.from(encodedKey, "base64");
    // Buffer's base64 decoder silently ignores malformed characters.
    if (
      key.length === 0 ||
      key.toString("base64").replace(/=+$/, "") !== encodedKey.replace(/=+$/, "")
    ) {
      return false;
    }
    const expected = NodeCrypto.createHmac("sha256", key)
      .update(`${id}.${timestamp}.`)
      .update(input.body)
      .digest("base64");
    return signatures
      .split(" ")
      .some((entry) => entry.startsWith("v1,") && constantTimeEquals(entry.slice(3), expected));
  }

  const received = input.headers[input.signature.header.toLowerCase()];
  if (received === undefined) return false;
  const value = received.trim();
  const prefix = input.signature.prefix;
  if (prefix !== "" && !value.toLowerCase().startsWith(prefix.toLowerCase())) return false;
  const digest = NodeCrypto.createHmac("sha256", input.secret).update(input.body).digest();
  const expected =
    input.signature.encoding === "hex" ? digest.toString("hex") : digest.toString("base64");
  const candidate = value.slice(prefix.length);
  return constantTimeEquals(
    input.signature.encoding === "hex" ? candidate.toLowerCase() : candidate,
    expected,
  );
}

/** Only this exact payload is a subscription handshake; it never becomes a prompt. */
export const decodeWebhookVerificationChallenge = Schema.decodeOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("verification"),
      challenge: Schema.String.check(Schema.isMaxLength(128)),
    }),
  ),
  { onExcessProperty: "error" },
);
