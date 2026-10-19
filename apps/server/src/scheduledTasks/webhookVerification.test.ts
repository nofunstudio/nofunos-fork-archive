// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";

import { verifyWebhookSignature } from "./webhookVerification.ts";

const body = new TextEncoder().encode('{"action":"opened"}');
const secret = "shared-secret";
const hmac = () => NodeCrypto.createHmac("sha256", secret).update(body);

describe("verifyWebhookSignature", () => {
  const github = { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" } as const;

  it("accepts a GitHub-style hex signature with prefix", () => {
    const headers = { "x-hub-signature-256": `sha256=${hmac().digest("hex")}` };
    assert.isTrue(verifyWebhookSignature({ signature: github, secret, headers, body }));
  });

  it("rejects a tampered body, a wrong secret, a missing header and a missing prefix", () => {
    const valid = `sha256=${hmac().digest("hex")}`;
    const tampered = new TextEncoder().encode('{"action":"closed"}');
    assert.isFalse(
      verifyWebhookSignature({
        signature: github,
        secret,
        headers: { "x-hub-signature-256": valid },
        body: tampered,
      }),
    );
    assert.isFalse(
      verifyWebhookSignature({
        signature: github,
        secret: "other",
        headers: { "x-hub-signature-256": valid },
        body,
      }),
    );
    assert.isFalse(verifyWebhookSignature({ signature: github, secret, headers: {}, body }));
    assert.isFalse(
      verifyWebhookSignature({
        signature: github,
        secret,
        headers: { "x-hub-signature-256": hmac().digest("hex") },
        body,
      }),
    );
  });

  it("accepts a base64 signature without prefix", () => {
    assert.isTrue(
      verifyWebhookSignature({
        signature: { header: "X-Signature", encoding: "base64", prefix: "" },
        secret,
        headers: { "x-signature": hmac().digest("base64") },
        body,
      }),
    );
  });
});

describe("Standard Webhooks signatures", () => {
  const signature = {
    scheme: "standard-webhooks",
    header: "ignored",
    encoding: "hex",
    prefix: "ignored",
  } as const;
  const key = Buffer.from("fixed-test-signing-key");
  const secret = `whsec_${key.toString("base64")}`;
  const id = "msg_fixed";
  const timestamp = "1792396800";
  const nowMillis = Number(timestamp) * 1_000;
  const body = new TextEncoder().encode('{"type":"message.created","data":{"text":"café"}}');
  const expected = NodeCrypto.createHmac("sha256", key)
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest("base64");
  const headers = {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${expected}`,
  };

  it("accepts a known answer over id, timestamp and exact body bytes", () => {
    assert.isTrue(verifyWebhookSignature({ signature, secret, headers, body, nowMillis }));
  });

  it("rejects a wrong secret and changes to any signed field", () => {
    assert.isFalse(
      verifyWebhookSignature({
        signature,
        secret: `whsec_${Buffer.from("wrong").toString("base64")}`,
        headers,
        body,
        nowMillis,
      }),
    );
    for (const changed of [
      { ...headers, "webhook-id": "other" },
      { ...headers, "webhook-timestamp": String(Number(timestamp) + 1) },
    ]) {
      assert.isFalse(
        verifyWebhookSignature({ signature, secret, headers: changed, body, nowMillis }),
      );
    }
    assert.isFalse(
      verifyWebhookSignature({
        signature,
        secret,
        headers,
        body: new TextEncoder().encode("{}"),
        nowMillis,
      }),
    );
  });

  it("bounds timestamps to 300 seconds in either direction", () => {
    for (const offset of [-300_001, 300_001]) {
      assert.isFalse(
        verifyWebhookSignature({ signature, secret, headers, body, nowMillis: nowMillis + offset }),
      );
    }
    for (const offset of [-300_000, 300_000]) {
      assert.isTrue(
        verifyWebhookSignature({ signature, secret, headers, body, nowMillis: nowMillis + offset }),
      );
    }
  });

  it("accepts a second v1 signature during secret rotation", () => {
    assert.isTrue(
      verifyWebhookSignature({
        signature,
        secret,
        headers: { ...headers, "webhook-signature": `v1,invalid v2,ignored v1,${expected}` },
        body,
        nowMillis,
      }),
    );
  });

  it("rejects missing or malformed signing metadata and keys", () => {
    for (const name of Object.keys(headers)) {
      assert.isFalse(
        verifyWebhookSignature({
          signature,
          secret,
          headers: { ...headers, [name]: "" },
          body,
          nowMillis,
        }),
      );
    }
    for (const value of ["NaN", "Infinity", "1.5", "-1", "1792396800junk"]) {
      assert.isFalse(
        verifyWebhookSignature({
          signature,
          secret,
          headers: { ...headers, "webhook-timestamp": value },
          body,
          nowMillis,
        }),
      );
    }
    for (const value of ["whsec_", "not-a-whsec-secret", "whsec_!!!"]) {
      assert.isFalse(
        verifyWebhookSignature({ signature, secret: value, headers, body, nowMillis }),
      );
    }
    assert.isFalse(verifyWebhookSignature({ signature, secret, headers, body }));
    assert.isFalse(
      verifyWebhookSignature({ signature, secret, headers, body, nowMillis: Number.NaN }),
    );
  });
});
