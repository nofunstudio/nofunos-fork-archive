// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac or generateKeyPairSync.
import * as NodeCrypto from "node:crypto";

import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentHttpApi,
  EnvironmentId,
  ScheduledTaskUpsertInput,
  SecretRequestError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/http/Etag";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as EffectScheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as WebhookRoute from "./webhookRoute.ts";
import * as RelayDeliveryProof from "./RelayDeliveryProof.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { CLOUD_MINT_PUBLIC_KEY, RELAY_ISSUER_SECRET } from "../cloud/config.ts";
import * as HookForwarder from "../../../../infra/relay/src/hooks/HookForwarder.ts";
import * as HeldHooks from "../../../../infra/relay/src/hooks/HeldHooks.ts";
import * as HookInbox from "../../../../infra/relay/src/hooks/HookInbox.ts";
import * as RelayConfiguration from "../../../../infra/relay/src/Config.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

type LaunchInput = ThreadLaunchService.ThreadLaunchInput;

const webhookTaskInput = (overrides: Record<string, unknown> = {}) =>
  decodeUpsertInput({
    id: "scheduled-task:hook",
    title: "Review PRs",
    prompt: "Review this PR: {{body.pull_request.url}}",
    enabled: true,
    schedule: { type: "webhook" },
    projectId: "project-webhook",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  });

const pullRequestBody = new TextEncoder().encode(
  JSON.stringify({ pull_request: { url: "https://github.com/org/repo/pull/45" } }),
);

const requestFor = (
  task: { readonly id: string; readonly webhook?: { readonly path: string } | undefined },
  overrides: Partial<ScheduledTaskService.WebhookTriggerRequest> = {},
): ScheduledTaskService.WebhookTriggerRequest => ({
  hookId: task.id,
  token: task.webhook?.path.split("/").at(-1) ?? "",
  method: "POST",
  path: `/api/hooks/${task.id}`,
  query: "",
  headers: { "content-type": "application/json" },
  body: pullRequestBody,
  bodyText: new TextDecoder().decode(pullRequestBody),
  ...overrides,
});

/**
 * Runs `body` against a service whose launches are pushed to `launches`;
 * `gate`, when given, holds each launch until the test releases it.
 */
const withService = <A, E>(
  body: (input: {
    readonly service: ScheduledTaskService.ScheduledTaskService["Service"];
    readonly launches: Queue.Queue<LaunchInput>;
    /** Secrets the user entered for an agent, by ref; consuming one removes it. */
    readonly secretsByRef: Map<string, string>;
  }) => Effect.Effect<A, E, never>,
  options: { readonly gate?: Deferred.Deferred<void>; readonly relayHookBaseUrl?: string } = {},
) =>
  Effect.gen(function* () {
    const launches = yield* Queue.unbounded<LaunchInput>();
    const secretsByRef = new Map<string, string>();
    const layerDependencies = Layer.mergeAll(
      NodePlatformCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (input) =>
          Queue.offer(launches, input).pipe(
            Effect.andThen(options.gate ? Deferred.await(options.gate) : Effect.void),
            Effect.as({ threadId: "thread-1", resumed: false } as never),
          ),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({
        consume: ({ ref }) => {
          const value = secretsByRef.get(ref);
          secretsByRef.delete(ref);
          return value === undefined
            ? Effect.fail(new SecretRequestError({ reason: "ref_unavailable" }))
            : Effect.succeed(value);
        },
      }),
      Layer.succeed(
        ScheduledTaskService.ScheduledTaskWebhookOrigin,
        Effect.succeed({ relayHookBaseUrl: options.relayHookBaseUrl ?? null }),
      ),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      return yield* body({ service, launches, secretsByRef });
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));

it.effect("dispatches exactly the rendered prompt and logs the delivery", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      assert.equal(task.nextRunAt, null);
      assert.isDefined(task.webhook);
      assert.isTrue(task.webhook!.path.startsWith("/api/hooks/scheduled-task%3Ahook/"));
      // Not linked to T3 Connect in tests.
      assert.equal(task.webhook!.url, null);

      const result = yield* service.triggerWebhook(requestFor(task));
      assert.equal(result._tag, "accepted");
      const launched = yield* Queue.take(launches);
      assert.equal(
        launched.initialMessage?.text,
        "Review this PR: https://github.com/org/repo/pull/45",
      );
      assert.equal(
        launched.commandId,
        `scheduled-task:${task.id}:webhook:${result._tag === "accepted" ? result.deliveryId : ""}`,
      );

      const { deliveries } = yield* service.listWebhookDeliveries({ id: task.id });
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0]?.outcome, "accepted");
      const { delivery } = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: deliveries[0]!.id,
      });
      assert.equal(delivery.body, new TextDecoder().decode(pullRequestBody));
      assert.equal(delivery.renderedPrompt, launched.initialMessage?.text);
    }),
  ),
);

it("builds the relay hook URL from the managed tunnel's key, never the environment id", () => {
  const relayUrl = "https://relay.example.com/";
  assert.equal(
    ScheduledTaskService.relayHookBaseUrl({
      relayUrl,
      tunnelName: "t3coderelay-managedendpoint-dev-julius-0123456789abcdef",
    }),
    "https://relay.example.com/v1/hooks/0123456789abcdef",
  );
  for (const tunnelName of [undefined, "t3coderelay-managedendpoint", "x-0123456789ABCDEF"]) {
    assert.isNull(ScheduledTaskService.relayHookBaseUrl({ relayUrl, tunnelName }));
  }
});

it.effect("gives webhook tasks a relay URL when the environment has a managed tunnel", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(yield* webhookTaskInput());
        const token = task.webhook!.path.split("/").at(-1);
        assert.equal(
          task.webhook?.url,
          `https://relay.example.com/v1/hooks/0123456789abcdef/scheduled-task%3Ahook/${token}`,
        );
      }),
    { relayHookBaseUrl: "https://relay.example.com/v1/hooks/0123456789abcdef" },
  ),
);

it.effect("answers not found for a wrong token or unknown hook without logging", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      const wrongToken = yield* service.triggerWebhook(requestFor(task, { token: "nope" }));
      assert.equal(wrongToken._tag, "not_found");
      const unknown = yield* service.triggerWebhook(requestFor(task, { hookId: "missing" }));
      assert.equal(unknown._tag, "not_found");
      assert.equal((yield* service.listWebhookDeliveries({ id: task.id })).deliveries.length, 0);
    }),
  ),
);

it.effect("rotating the token retires the old URL and saving keeps it", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const input = yield* webhookTaskInput();
      const { task } = yield* service.upsert(input);
      const saved = yield* service.upsert(yield* webhookTaskInput({ title: "Renamed" }));
      assert.equal(saved.task.webhook?.path, task.webhook?.path);

      const rotated = yield* service.rotateWebhookToken({ id: task.id });
      assert.notEqual(rotated.task.webhook?.path, task.webhook?.path);
      assert.equal((yield* service.triggerWebhook(requestFor(task)))._tag, "not_found");
      assert.equal((yield* service.triggerWebhook(requestFor(rotated.task)))._tag, "accepted");
    }),
  ),
);

it.effect("checks the configured signature and keeps the secret write-only", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: {
            type: "webhook",
            signature: {
              header: "X-Hub-Signature-256",
              encoding: "hex",
              prefix: "sha256=",
              secret: "s3cret",
            },
          },
        }),
      );
      assert.deepEqual(task.schedule, {
        type: "webhook",
        signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" },
        maxDeliveryAgeMinutes: null,
      });
      assert.isTrue(task.webhook?.hasSecret);

      const unsigned = yield* service.triggerWebhook(requestFor(task));
      assert.equal(unsigned._tag, "rejected_signature");

      const signature = `sha256=${NodeCrypto.createHmac("sha256", "s3cret").update(pullRequestBody).digest("hex")}`;
      const signed = yield* service.triggerWebhook(
        requestFor(task, {
          headers: { "content-type": "application/json", "x-hub-signature-256": signature },
        }),
      );
      assert.equal(signed._tag, "accepted");

      // Saving without a secret keeps the stored one.
      const resaved = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: {
            type: "webhook",
            signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" },
          },
        }),
      );
      assert.isTrue(resaved.task.webhook?.hasSecret);

      const outcomes = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries.map(
        (delivery) => [delivery.outcome, delivery.signatureVerified],
      );
      assert.deepEqual(outcomes.toSorted(), [
        ["accepted", true],
        ["rejected_signature", false],
      ]);
    }),
  ),
);

it.effect("logs but does not run deliveries to a disabled task, and refuses run now", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      assert.equal((yield* service.triggerWebhook(requestFor(task)))._tag, "disabled");
      assert.equal(yield* Queue.size(launches), 0);
      const runNow = yield* service.runNow({ id: task.id }).pipe(Effect.flip);
      assert.equal(runNow.message, "Webhook tasks run when their URL receives a request.");
    }),
  ),
);

it.effect("queues a burst of deliveries instead of dropping them", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    yield* withService(
      ({ service, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(yield* webhookTaskInput());
          const results = yield* Effect.forEach([1, 2, 3], () =>
            service.triggerWebhook(requestFor(task)),
          );
          assert.deepEqual(
            results.map((result) => result._tag),
            ["accepted", "accepted", "accepted"],
          );
          // Only the first is dispatching; the others wait their turn.
          yield* Queue.take(launches);
          yield* Deferred.succeed(gate, undefined);
          const rest = yield* Effect.all([Queue.take(launches), Queue.take(launches)]);
          assert.equal(new Set(rest.map((launch) => launch.commandId)).size, 2);
        }),
      { gate },
    );
  }),
);

it.effect("rate limits a hook past 60 deliveries a minute", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      const results = yield* Effect.forEach(Array.from({ length: 61 }), () =>
        service.triggerWebhook(requestFor(task)),
      );
      assert.equal(results.at(-2)?._tag, "disabled");
      assert.equal(results.at(-1)?._tag, "rate_limited");
      // Further rejections in the same window are counted, not logged.
      yield* Effect.forEach([1, 2, 3], () => service.triggerWebhook(requestFor(task)));
      const outcomes = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries.map(
        (delivery) => delivery.outcome,
      );
      assert.equal(outcomes.filter((outcome) => outcome === "rate_limited").length, 1);
    }),
  ),
);

it.effect("a save carrying a stale token cannot undo a rotation", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      const rotated = yield* service.rotateWebhookToken({ id: task.id });
      // The editor was opened before the rotation and saves afterwards.
      const saved = yield* service.upsert(yield* webhookTaskInput({ title: "Edited" }));
      assert.equal(saved.task.webhook?.path, rotated.task.webhook?.path);
      assert.equal((yield* service.triggerWebhook(requestFor(task)))._tag, "not_found");
    }),
  ),
);

it.effect("keeps the newest 50 deliveries when they share a timestamp", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      // Paused, so each request is logged without starting a run. The test
      // clock is frozen, so every delivery has the same received_at.
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      const ids = yield* Effect.forEach(Array.from({ length: 55 }), (_, index) =>
        service.triggerWebhook(requestFor(task, { query: `n=${index}` })).pipe(Effect.as(index)),
      );
      const { deliveries } = yield* service.listWebhookDeliveries({ id: task.id });
      assert.equal(deliveries.length, 50);
      const first = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: deliveries[0]!.id,
      });
      const last = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: deliveries.at(-1)!.id,
      });
      assert.equal(first.delivery.query, `n=${ids.at(-1)}`);
      assert.equal(last.delivery.query, "n=5");
    }),
  ),
);

it.effect("keeps credential headers and query values out of the delivery log", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      yield* service.triggerWebhook(
        requestFor(task, {
          query: "page=2&api_key=k",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer sender-token",
            "x-webhook-key": "k",
            "x-github-event": "push",
          },
        }),
      );
      const [summary] = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries;
      const { delivery } = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: summary!.id,
      });
      assert.equal(delivery.query, "page=2&api_key=[redacted]");
      assert.equal(delivery.headers.authorization, "[redacted]");
      assert.equal(delivery.headers["x-webhook-key"], "[redacted]");
      assert.equal(delivery.headers["x-github-event"], "push");
    }),
  ),
);

const queuedDeliveryCases = [
  {
    change: "paused",
    reason: "The task was paused before this delivery ran.",
    apply: (service: ScheduledTaskService.ScheduledTaskService["Service"], id: string) =>
      service.setEnabled({ id: id as never, enabled: false }),
  },
  {
    change: "switched to an interval trigger",
    reason: "The task's trigger changed before this delivery ran.",
    apply: (service: ScheduledTaskService.ScheduledTaskService["Service"]) =>
      webhookTaskInput({ schedule: { type: "interval", everyMs: 3_600_000 } }).pipe(
        Effect.flatMap(service.upsert),
      ),
  },
] as const;

it.effect.each(queuedDeliveryCases)(
  "a delivery queued behind a run does not start once the task is $change",
  ({ reason, apply }) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      yield* withService(
        ({ service, launches }) =>
          Effect.gen(function* () {
            const { task } = yield* service.upsert(yield* webhookTaskInput());
            yield* service.triggerWebhook(requestFor(task));
            const queued = yield* service.triggerWebhook(requestFor(task));
            yield* Queue.take(launches);
            yield* apply(service, task.id);
            yield* Deferred.succeed(gate, undefined);
            // The queued delivery is marked failed instead of launching.
            const deliveryId = queued._tag === "accepted" ? queued.deliveryId : undefined;
            let delivery = (yield* service.getWebhookDelivery({
              id: task.id,
              deliveryId: deliveryId!,
            })).delivery;
            while (delivery.outcome === "accepted") {
              yield* Effect.yieldNow;
              delivery = (yield* service.getWebhookDelivery({
                id: task.id,
                deliveryId: deliveryId!,
              })).delivery;
            }
            assert.equal(delivery.outcome, "dispatch_failed");
            assert.equal(delivery.error, reason);
            assert.equal(yield* Queue.size(launches), 0);
          }),
        { gate },
      );
    }),
);

it.effect("a save without a secret keeps a secret changed after it was read", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const signature = { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" };
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: { type: "webhook", signature: { ...signature, secret: "old" } },
        }),
      );
      yield* service.upsert(
        yield* webhookTaskInput({
          schedule: { type: "webhook", signature: { ...signature, secret: "new" } },
        }),
      );
      // A form opened before the change saves without sending a secret.
      yield* service.upsert(
        yield* webhookTaskInput({ title: "Edited", schedule: { type: "webhook", signature } }),
      );
      const sign = (secret: string) =>
        `sha256=${NodeCrypto.createHmac("sha256", secret).update(pullRequestBody).digest("hex")}`;
      const withSignature = (secret: string) =>
        requestFor(task, {
          headers: { "content-type": "application/json", "x-hub-signature-256": sign(secret) },
        });
      assert.equal(
        (yield* service.triggerWebhook(withSignature("old")))._tag,
        "rejected_signature",
      );
      assert.equal((yield* service.triggerWebhook(withSignature("new")))._tag, "accepted");
    }),
  ),
);

it.effect("caps deliveries waiting behind a stuck run", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    yield* withService(
      ({ service, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(yield* webhookTaskInput());
          yield* service.triggerWebhook(requestFor(task));
          yield* Queue.take(launches);
          // The cap counts the running delivery too: 19 more wait, the next is refused.
          const waiting = yield* Effect.forEach(Array.from({ length: 20 }), () =>
            service.triggerWebhook(requestFor(task)),
          );
          assert.equal(waiting.filter((result) => result._tag === "accepted").length, 19);
          assert.equal(waiting.at(-1)?._tag, "rate_limited");
          // The refused request is not logged.
          const logged = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries;
          assert.equal(logged.length, 20);
          yield* Deferred.succeed(gate, undefined);
        }),
      { gate },
    );
  }),
);

it.effect("logs a body's first 64 KiB by bytes, not characters", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      // 30 000 three-byte characters: under 64 Ki characters, over 64 KiB.
      const text = "界".repeat(30_000);
      const body = new TextEncoder().encode(text);
      yield* service.triggerWebhook(requestFor(task, { body, bodyText: text }));
      const [summary] = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries;
      const { delivery } = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: summary!.id,
      });
      assert.isTrue(delivery.bodyTruncated);
      assert.isAtMost(new TextEncoder().encode(delivery.body).byteLength, 64 * 1024 + 3);
    }),
  ),
);

it.effect("counts the prompt as the provider does, without surrounding whitespace", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ prompt: "{{body.text}}" }));
      // Over the limit as sent, within it once the padding is trimmed.
      const text = `{"text":"${" ".repeat(1_000)}${"x".repeat(119_990)}${"\\n".repeat(1_000)}"}`;
      const result = yield* service.triggerWebhook(
        requestFor(task, { body: new TextEncoder().encode(text), bodyText: text }),
      );
      assert.equal(result._tag, "accepted");
      yield* Queue.take(launches);
    }),
  ),
);

it.effect("does not start a run when the filled-in prompt is too long", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ prompt: "{{body}}" }));
      const text = "x".repeat(200_000);
      const body = new TextEncoder().encode(text);
      const result = yield* service.triggerWebhook(requestFor(task, { body, bodyText: text }));
      assert.equal(result._tag, "accepted");
      assert.equal(yield* Queue.size(launches), 0);
      const { delivery } = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: result._tag === "accepted" ? result.deliveryId : ("" as never),
      });
      assert.equal(delivery.outcome, "dispatch_failed");
      assert.equal(delivery.error, "The filled-in prompt is too long.");
      assert.equal(delivery.renderedPrompt?.length, 64 * 1024);
      // The queue slot was never taken: a normal delivery still runs.
      const ok = yield* service.triggerWebhook(requestFor(task));
      assert.equal(ok._tag, "accepted");
      yield* Queue.take(launches);
    }),
  ),
);

it.effect("a held request already delivered directly runs only once", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      const direct = yield* service.triggerWebhook(
        requestFor(task, { relayDeliveryId: "relay-1" }),
      );
      const replayed = yield* service.triggerWebhook(
        requestFor(task, { relayDeliveryId: "relay-1", receivedAt: "2026-10-04T10:00:00.000Z" }),
      );
      assert.equal(direct._tag, "accepted");
      // Same delivery, answered the same way, but recorded as a duplicate.
      assert.deepEqual(replayed, { ...direct, outcome: "duplicate" } as typeof replayed);
      yield* Queue.take(launches);
      const logged = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries;
      assert.equal(logged.length, 1);
    }),
  ),
);

it.effect("a held request whose sender hung up mid-request still runs", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      // The relay times out and the request fiber is interrupted. A small
      // operation budget makes the request yield often, so stepping the
      // interrupt one yield later each time lands it at every point in the
      // request (one takes about 40 yields), then the relay retries.
      for (let step = 0; step < 60; step++) {
        const request = requestFor(task, { relayDeliveryId: `hung-up-${step}` });
        const fiber = yield* service
          .triggerWebhook(request)
          .pipe(Effect.provideService(EffectScheduler.MaxOpsBeforeYield, 8), Effect.forkChild);
        for (let yields = 0; yields < step; yields++) yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        const retried = yield* service.triggerWebhook(request);
        assert.equal(retried._tag, "accepted");
        const deliveryId = retried._tag === "accepted" ? retried.deliveryId : undefined;
        // Logged and run exactly once, whether or not the first attempt got through.
        yield* service.getWebhookDelivery({ id: task.id, deliveryId: deliveryId! });
        const launch = yield* Queue.take(launches);
        assert.include(launch.commandId, `hung-up-${step}`);
        // Keep each step in a fresh rate-limit window.
        yield* TestClock.adjust("61 seconds");
      }
      assert.equal(yield* Queue.size(launches), 0);
    }),
  ),
);

it.effect("a held request runs once even after the log has trimmed it", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      const first = yield* service.triggerWebhook(requestFor(task, { relayDeliveryId: "kept" }));
      assert.equal(first._tag, "accepted");
      yield* Queue.take(launches);
      // Push the original row out of the 50-row delivery log.
      const paused = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      yield* Effect.forEach(Array.from({ length: 55 }), () =>
        service.triggerWebhook(requestFor(paused.task)),
      );
      yield* service.upsert(yield* webhookTaskInput());
      const replay = yield* service.triggerWebhook(requestFor(task, { relayDeliveryId: "kept" }));
      assert.equal(replay._tag, "accepted");
      assert.equal(yield* Queue.size(launches), 0);
    }),
  ),
);

it.effect("a rate-limited held request can run on a later pass", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      // Spend the task's 60-a-minute budget.
      yield* Effect.forEach(Array.from({ length: 60 }), () =>
        service.triggerWebhook(requestFor(task)),
      );
      const limited = yield* service.triggerWebhook(requestFor(task, { relayDeliveryId: "later" }));
      assert.equal(limited._tag, "rate_limited");
      yield* service.upsert(yield* webhookTaskInput());
      yield* TestClock.adjust("61 seconds");
      const retried = yield* service.triggerWebhook(requestFor(task, { relayDeliveryId: "later" }));
      assert.equal(retried._tag, "accepted");
      yield* Queue.take(launches);
    }),
  ),
);

it.effect("logs a held request at the time the relay received it", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      const receivedAt = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 5 }));
      yield* service.triggerWebhook(requestFor(task, { relayDeliveryId: "relay-2", receivedAt }));
      const [delivery] = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries;
      assert.equal(delivery?.receivedAt, receivedAt);
    }),
  ),
);

it.effect("a receive time in the future counts as now", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({ schedule: { type: "webhook", maxDeliveryAgeMinutes: 30 } }),
      );
      const now = yield* DateTime.now;
      const result = yield* service.triggerWebhook(
        requestFor(task, {
          relayDeliveryId: "future",
          receivedAt: DateTime.formatIso(DateTime.add(now, { days: 365 })),
        }),
      );
      assert.equal(result._tag, "accepted");
      yield* Queue.take(launches);
      const [delivery] = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries;
      assert.equal(delivery?.receivedAt, DateTime.formatIso(now));
    }),
  ),
);

it.effect("skips a held request older than the task's max age", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({ schedule: { type: "webhook", maxDeliveryAgeMinutes: 30 } }),
      );
      const now = yield* DateTime.now;
      const old = DateTime.formatIso(DateTime.subtract(now, { minutes: 31 }));
      const fresh = DateTime.formatIso(DateTime.subtract(now, { minutes: 5 }));
      const tooOld = yield* service.triggerWebhook(
        requestFor(task, { relayDeliveryId: "old", receivedAt: old }),
      );
      assert.equal(tooOld._tag, "expired");
      assert.equal(yield* Queue.size(launches), 0);
      const ok = yield* service.triggerWebhook(
        requestFor(task, { relayDeliveryId: "fresh", receivedAt: fresh }),
      );
      assert.equal(ok._tag, "accepted");
      const outcomes = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries.map(
        (delivery) => delivery.outcome,
      );
      assert.includeMembers(outcomes, ["expired", "accepted"]);
    }),
  ),
);

it.effect("runs a held request of any age when no max age is set", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      const now = yield* DateTime.now;
      const result = yield* service.triggerWebhook(
        requestFor(task, {
          relayDeliveryId: "ancient",
          receivedAt: DateTime.formatIso(DateTime.subtract(now, { hours: 23 })),
        }),
      );
      assert.equal(result._tag, "accepted");
    }),
  ),
);

it.effect("deleting a task removes its delivery log", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ enabled: false }));
      yield* service.triggerWebhook(requestFor(task));
      yield* service.delete({ id: task.id });
      assert.equal((yield* service.listWebhookDeliveries({ id: task.id })).deliveries.length, 0);
    }),
  ),
);

const githubSignature = (secret: string) =>
  `sha256=${NodeCrypto.createHmac("sha256", secret).update(pullRequestBody).digest("hex")}`;

it.effect("a signature can take the user's secret by ref, which works only once", () =>
  withService(({ service, launches, secretsByRef }) =>
    Effect.gen(function* () {
      secretsByRef.set("secret-ref:00000000000000000000000000000001", "github-secret");
      const githubSchedule = (secretRef: string) => ({
        type: "webhook",
        signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=", secretRef },
      });
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: githubSchedule("secret-ref:00000000000000000000000000000001"),
        }),
      );
      assert.isTrue(task.webhook!.hasSecret);
      const signed = yield* service.triggerWebhook(
        requestFor(task, {
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": githubSignature("github-secret"),
          },
        }),
      );
      assert.equal(signed._tag, "accepted");
      yield* Queue.take(launches);

      // The ref was consumed by that save.
      const reused = yield* service
        .upsert(
          yield* webhookTaskInput({
            id: "scheduled-task:other",
            schedule: githubSchedule("secret-ref:00000000000000000000000000000001"),
          }),
        )
        .pipe(Effect.flip);
      assert.include(reused.message, "already used");
    }),
  ),
);

it.effect("a retried save with an already used secretRef keeps the stored secret", () =>
  withService(({ service, launches, secretsByRef }) =>
    Effect.gen(function* () {
      secretsByRef.set("secret-ref:00000000000000000000000000000002", "github-secret");
      const save = webhookTaskInput({
        id: undefined,
        commandId: "command:mcp:schedule-task:release-hook",
        schedule: {
          type: "webhook",
          signature: {
            header: "x-hub-signature-256",
            encoding: "hex",
            prefix: "sha256=",
            secretRef: "secret-ref:00000000000000000000000000000002",
          },
        },
      });
      const first = yield* service.upsert(yield* save);
      // The agent never saw the first result, so it sends the same call again,
      // this time with a plain secret alongside the used ref.
      const retried = yield* service.upsert(
        yield* webhookTaskInput({
          id: undefined,
          commandId: "command:mcp:schedule-task:release-hook",
          schedule: {
            type: "webhook",
            signature: {
              header: "x-hub-signature-256",
              encoding: "hex",
              prefix: "sha256=",
              secretRef: "secret-ref:00000000000000000000000000000002",
              secret: "made-up-secret",
            },
          },
        }),
      );
      assert.equal(retried.task.id, first.task.id);
      const signed = yield* service.triggerWebhook(
        requestFor(retried.task, {
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": githubSignature("github-secret"),
          },
        }),
      );
      assert.equal(signed._tag, "accepted");
      yield* Queue.take(launches);
    }),
  ),
);

it.effect("a signature without any secret is refused", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const failure = yield* service
        .upsert(
          yield* webhookTaskInput({
            schedule: {
              type: "webhook",
              signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" },
            },
          }),
        )
        .pipe(Effect.flip);
      assert.include(failure.message, "needs a signing secret");
    }),
  ),
);

const signatureFor = (secret: string) =>
  `sha256=${NodeCrypto.createHmac("sha256", secret).update(pullRequestBody).digest("hex")}`;

/** Count recorded by `t3_webhook_deliveries_total` for one outcome and source. */
const deliveriesCounted = (outcome: string, source: "relay" | "direct") =>
  Metric.snapshot.pipe(
    Effect.map((snapshots) => {
      const found = snapshots.find(
        (snapshot) =>
          snapshot.id === "t3_webhook_deliveries_total" &&
          snapshot.attributes?.outcome === outcome &&
          snapshot.attributes?.source === source,
      );
      return found?.type === "Counter" ? Number(found.state.count) : 0;
    }),
  );

it.effect("counts each handled request by what happened to it", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* webhookTaskInput({
          schedule: {
            type: "webhook",
            signature: {
              header: "x-hub-signature-256",
              encoding: "hex",
              prefix: "sha256=",
              secret: "github-secret",
            },
          },
        }),
      );
      const before = {
        accepted: yield* deliveriesCounted("accepted", "direct"),
        rejected: yield* deliveriesCounted("rejected_signature", "direct"),
        notFound: yield* deliveriesCounted("not_found", "direct"),
        relayAccepted: yield* deliveriesCounted("accepted", "relay"),
        duplicate: yield* deliveriesCounted("duplicate", "relay"),
      };
      const signed = {
        "content-type": "application/json",
        "x-hub-signature-256": signatureFor("github-secret"),
      };
      yield* service.triggerWebhook(requestFor(task, { headers: signed }));
      yield* Queue.take(launches);
      yield* service.triggerWebhook(requestFor(task));
      yield* service.triggerWebhook(requestFor(task, { token: "wrong" }));
      // A request the relay held, then the same request again.
      const relayed = requestFor(task, { headers: signed, relayDeliveryId: "relay-1" });
      yield* service.triggerWebhook(relayed);
      yield* Queue.take(launches);
      yield* service.triggerWebhook(relayed);

      assert.equal((yield* deliveriesCounted("accepted", "direct")) - before.accepted, 1);
      assert.equal((yield* deliveriesCounted("rejected_signature", "direct")) - before.rejected, 1);
      assert.equal((yield* deliveriesCounted("not_found", "direct")) - before.notFound, 1);
      assert.equal((yield* deliveriesCounted("accepted", "relay")) - before.relayAccepted, 1);
      assert.equal((yield* deliveriesCounted("duplicate", "relay")) - before.duplicate, 1);
    }),
  ),
);

const standardSecret = `whsec_${Buffer.from("fixed-standard-webhooks-key").toString("base64")}`;
const standardTaskInput = (overrides: Record<string, unknown> = {}) =>
  webhookTaskInput({
    prompt: "{{body.type}} {{body.data.source_message_id}}",
    schedule: {
      type: "webhook",
      signature: { scheme: "standard-webhooks", secret: standardSecret },
    },
    ...overrides,
  });
const standardRequest = Effect.fn("standardRequest")(function* (
  task: Parameters<typeof requestFor>[0],
  id: string,
  payload: unknown = { type: "message.created", data: { source_message_id: "source-1" } },
) {
  const bodyText = yield* encodePayload(payload);
  const timestamp = String(Math.floor((yield* Clock.currentTimeMillis) / 1_000));
  return requestFor(task, {
    bodyText,
    body: new TextEncoder().encode(bodyText),
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${NodeCrypto.createHmac(
        "sha256",
        Buffer.from(standardSecret.slice(6), "base64"),
      )
        .update(`${id}.${timestamp}.${bodyText}`)
        .digest("base64")}`,
    },
  });
});

it.effect(
  "echoes only a signed Standard Webhooks challenge and records verification without a run",
  () =>
    withService(({ service, launches, secretsByRef }) =>
      Effect.gen(function* () {
        const secretRef = "secret:standard";
        secretsByRef.set(secretRef, standardSecret);
        const { task } = yield* service.upsert(
          yield* standardTaskInput({
            schedule: { type: "webhook", signature: { scheme: "standard-webhooks", secretRef } },
          }),
        );
        assert.equal(
          task.schedule.type === "webhook" && task.schedule.signature?.scheme,
          "standard-webhooks",
        );
        const request = yield* standardRequest(task, "verification-1", {
          type: "verification",
          challenge: "abc",
        });
        const result = yield* service.triggerWebhook(request);
        assert.equal(result._tag, "verification");
        if (result._tag !== "verification") return;
        assert.equal(result.challenge, "abc");
        assert.deepEqual(yield* service.triggerWebhook(request), result);
        assert.equal(yield* Queue.size(launches), 0);
        const { deliveries } = yield* service.listWebhookDeliveries({ id: task.id });
        assert.equal(deliveries.length, 1);
        assert.equal(deliveries[0]?.outcome, "verification");
        assert.isTrue(deliveries[0]?.signatureVerified);
        assert.equal(
          (yield* service.getWebhookDelivery({ id: task.id, deliveryId: deliveries[0]!.id }))
            .delivery.renderedPrompt,
          null,
        );
        const current = (yield* service.list()).tasks.find((item) => item.id === task.id);
        assert.equal(current?.runCount, 0);
      }),
    ),
);

it.effect(
  "rejects unsigned or bad-signature challenges without poisoning a signed webhook id",
  () =>
    withService(({ service, launches }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(yield* standardTaskInput());
        const request = yield* standardRequest(task, "challenge-1", {
          type: "verification",
          challenge: "abc",
        });
        for (const headers of [{}, { ...request.headers, "webhook-signature": "v1,invalid" }]) {
          assert.equal(
            (yield* service.triggerWebhook({ ...request, headers }))._tag,
            "rejected_signature",
          );
        }
        assert.equal(yield* Queue.size(launches), 0);
        assert.equal((yield* service.triggerWebhook(request))._tag, "verification");
        assert.equal(
          (yield* service.triggerWebhook({ ...request, headers: {} }))._tag,
          "rejected_signature",
        );
        assert.equal(yield* Queue.size(launches), 0);
      }),
    ),
);

it.effect(
  "renders a signed event and runs the same webhook-id once across direct and relay delivery",
  () =>
    withService(({ service, launches }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(yield* standardTaskInput());
        const request = yield* standardRequest(task, "event-1");
        const results = yield* Effect.all(
          [
            service.triggerWebhook(request),
            service.triggerWebhook({ ...request, relayDeliveryId: "relay-1" }),
            service.triggerWebhook({ ...request, relayDeliveryId: "relay-2" }),
          ],
          { concurrency: "unbounded" },
        );
        assert.deepEqual(
          results.map((result) => result._tag),
          ["accepted", "accepted", "accepted"],
        );
        const accepted = results.filter((result) => result._tag === "accepted");
        assert.equal(new Set(accepted.map((result) => result.deliveryId)).size, 1);
        assert.equal(accepted.filter((result) => result.outcome === "duplicate").length, 2);
        const launch = yield* Queue.take(launches);
        assert.equal(launch.initialMessage?.text, "message.created source-1");
        assert.equal(yield* Queue.size(launches), 0);
        assert.equal((yield* service.listWebhookDeliveries({ id: task.id })).deliveries.length, 1);
      }),
    ),
);

it.effect("uses Clock now to reject an old signed event without a run", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* standardTaskInput());
      const request = yield* standardRequest(task, "stale-event");
      yield* TestClock.adjust("301 seconds");
      assert.equal((yield* service.triggerWebhook(request))._tag, "rejected_signature");
      assert.equal(yield* Queue.size(launches), 0);
    }),
  ),
);

it.effect("keeps signed webhook id claims after the 50-row delivery log is trimmed", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* standardTaskInput());
      const request = yield* standardRequest(task, "kept-standard-id");
      const first = yield* service.triggerWebhook(request);
      if (first._tag !== "accepted") assert.fail("Expected the first event to be accepted");
      yield* Queue.take(launches);
      for (let index = 0; index < 51; index++) {
        assert.equal(
          (yield* service.triggerWebhook(yield* standardRequest(task, `other-${index}`)))._tag,
          "accepted",
        );
        yield* Queue.take(launches);
      }
      assert.equal((yield* service.listWebhookDeliveries({ id: task.id })).deliveries.length, 50);
      assert.deepEqual(yield* service.triggerWebhook(request), { ...first, outcome: "duplicate" });
      assert.equal(yield* Queue.size(launches), 0);
    }),
  ),
);

it.effect("scopes a signed webhook id to its task", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task: first } = yield* service.upsert(yield* standardTaskInput());
      const { task: second } = yield* service.upsert(
        yield* standardTaskInput({ id: "scheduled-task:other" }),
      );
      for (const task of [first, second]) {
        assert.equal(
          (yield* service.triggerWebhook(yield* standardRequest(task, "shared-id")))._tag,
          "accepted",
        );
        yield* Queue.take(launches);
      }
    }),
  ),
);

it.effect("does not treat malformed or extended verification payloads as challenges", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* standardTaskInput());
      const payloads = [
        { type: "verification", challenge: "a".repeat(129) },
        { type: "verification", challenge: 1 },
        { type: "verification", challenge: "abc", extra: true },
        { type: "verification" },
      ];
      for (const [index, payload] of payloads.entries()) {
        assert.equal(
          (yield* service.triggerWebhook(
            yield* standardRequest(task, `malformed-${index}`, payload),
          ))._tag,
          "accepted",
        );
        yield* Queue.take(launches);
      }
    }),
  ),
);

it.effect("answers verification with a full run queue and leaves retryable event claims free", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    yield* withService(
      ({ service, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(yield* standardTaskInput());
          yield* service.triggerWebhook(yield* standardRequest(task, "queue-0"));
          yield* Queue.take(launches);
          for (let index = 1; index < 20; index++) {
            assert.equal(
              (yield* service.triggerWebhook(yield* standardRequest(task, `queue-${index}`)))._tag,
              "accepted",
            );
          }
          const waiting = yield* standardRequest(task, "queue-retry");
          assert.equal((yield* service.triggerWebhook(waiting))._tag, "rate_limited");
          for (let index = 0; index < 2; index++) {
            assert.equal(
              (yield* service.triggerWebhook(
                yield* standardRequest(task, `challenge-${index}`, {
                  type: "verification",
                  challenge: "a".repeat(128),
                }),
              ))._tag,
              "verification",
            );
          }
          yield* Deferred.succeed(gate, undefined);
          for (let index = 1; index < 20; index++) yield* Queue.take(launches);
          yield* Effect.yieldNow;
          assert.equal((yield* service.triggerWebhook(waiting))._tag, "accepted");
          yield* Queue.take(launches);
        }),
      { gate },
    );
  }),
);

it.effect(
  "verifies challenges and events through both /api/hooks and the /v1/hooks relay using fixtures only",
  () =>
    withService(({ service, launches }) =>
      Effect.gen(function* () {
        const keys = NodeCrypto.generateKeyPairSync("ed25519", {
          privateKeyEncoding: { format: "pem", type: "pkcs8" },
          publicKeyEncoding: { format: "pem", type: "spki" },
        });
        const environmentId = EnvironmentId.make("env-standard-webhooks");
        const relayIssuer = "https://relay.example.test";
        const secrets = new Map([
          [CLOUD_MINT_PUBLIC_KEY, keys.publicKey],
          [RELAY_ISSUER_SECRET, relayIssuer],
        ]);
        const environment = HttpRouter.toHttpEffect(
          HttpApiBuilder.layer(
            HttpApi.make("environment").add(EnvironmentHttpApi.groups.webhooks),
          ).pipe(
            Layer.provide(WebhookRoute.layer),
            Layer.provide(RelayDeliveryProof.layer),
            Layer.provide(Layer.succeed(ScheduledTaskService.ScheduledTaskService, service)),
            Layer.provide(
              Layer.mock(ServerSecretStore.ServerSecretStore)({
                get: (name) =>
                  Effect.succeed(
                    Option.map(Option.fromUndefinedOr(secrets.get(name)), (value) =>
                      new TextEncoder().encode(value),
                    ),
                  ),
              }),
            ),
            Layer.provide(
              Layer.mock(ServerEnvironment.ServerEnvironment)({
                getEnvironmentId: Effect.succeed(environmentId),
              }),
            ),
            Layer.provide(
              HttpPlatform.layer.pipe(
                Layer.provideMerge(NodeServices.layer),
                Layer.provideMerge(Etag.layerWeak),
              ),
            ),
            Layer.provide(NodeServices.layer),
          ),
        );
        const handler = yield* environment;
        const sendEnvironment = (request: Request) =>
          Effect.gen(function* () {
            const sent = yield* Deferred.make<Response>();
            yield* HttpEffect.toHandled(handler, (_request, response) =>
              Deferred.succeed(sent, HttpServerResponse.toWeb(response)),
            ).pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(request),
              ),
            );
            return yield* Deferred.await(sent);
          });
        const forwarding = HookForwarder.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              NodePlatformCrypto.layer,
              Layer.mock(HeldHooks.HeldHooks)({
                resolveEndpoint: () =>
                  Effect.succeed({
                    httpBaseUrl: "https://env.example.test/",
                    environmentId,
                    holdWhileOffline: false,
                  }),
              }),
              Layer.mock(HookInbox.HookInbox)({}),
              Layer.succeed(RelayConfiguration.RelayConfiguration, {
                relayIssuer,
                apns: null,
                clerkSecretKey: Redacted.make("fixed-clerk-test-key"),
                clerkPublishableKey: "pk_test_fixed",
                clerkJwtAudience: "t3-code-relay",
                apnsDeliveryJobSigningSecret: Redacted.make("fixed-apns-test-key"),
                cloudMintPrivateKey: Redacted.make(keys.privateKey),
                cloudMintPublicKey: keys.publicKey,
                managedEndpointBaseDomain: "example.test",
                managedEndpointNamespace: "dev",
              }),
              Layer.succeed(HookForwarder.HookRateLimiter, {
                allowHook: () => Effect.succeed(true),
                allowEndpoint: () => Effect.succeed(true),
              }),
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) =>
                  sendEnvironment(
                    new Request(request.url, {
                      method: request.method,
                      headers: request.headers,
                      ...(request.body._tag === "Uint8Array"
                        ? { body: new Uint8Array(request.body.body) }
                        : {}),
                    }),
                  ).pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response))),
                ),
              ),
            ),
          ),
        );
        const forwarder = yield* HookForwarder.HookForwarder.pipe(Effect.provide(forwarding));
        const { task } = yield* service.upsert(yield* standardTaskInput());
        const publicUrl = `https://relay.example.test/v1/hooks/0123456789abcdef/${task.webhook!.path.slice("/api/hooks/".length)}`;
        const send = (request: ScheduledTaskService.WebhookTriggerRequest, relay: boolean) => {
          const webRequest = new Request(
            relay ? publicUrl : `https://env.example.test${task.webhook!.path}`,
            {
              method: "POST",
              body: request.bodyText,
              headers: request.headers,
            },
          );
          return relay
            ? forwarder
                .handle(HttpServerRequest.fromWeb(webRequest))
                .pipe(Effect.map((response) => HttpServerResponse.toWeb(response)))
            : sendEnvironment(webRequest);
        };
        for (const relay of [false, true]) {
          const request = yield* standardRequest(task, `http-challenge-${relay}`, {
            type: "verification",
            challenge: "challenge-echo",
          });
          const response = yield* send(request, relay);
          assert.equal(response.status, 200);
          assert.deepEqual(yield* Effect.promise(() => response.json()), {
            challenge: "challenge-echo",
          });
          const unsigned = yield* send({ ...request, headers: {} }, relay);
          assert.equal(unsigned.status, 401);
          assert.equal(yield* Queue.size(launches), 0);
        }
        const event = yield* standardRequest(task, "http-event");
        const response = yield* send(event, true);
        assert.equal(response.status, 202);
        const accepted = yield* Effect.promise(() => response.json());
        assert.equal(
          (yield* Queue.take(launches)).initialMessage?.text,
          "message.created source-1",
        );
        const replay = yield* send(event, false);
        assert.equal(replay.status, 202);
        assert.deepEqual(yield* Effect.promise(() => replay.json()), accepted);
        assert.equal(yield* Queue.size(launches), 0);
      }).pipe(Effect.scoped),
    ),
);
