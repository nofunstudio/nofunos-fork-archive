import * as NodePath from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { museAccountBinding, MuseAccountsFile, MuseStoredObservation } from "./museUsage.logic.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeStoredJson = Schema.decodeUnknownSync(Schema.fromJsonString(MuseStoredObservation));
const decodeAccountsJson = Schema.decodeUnknownSync(Schema.fromJsonString(MuseAccountsFile));
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as MuseUsage from "./MuseUsage.ts";
import { usageHeadroom } from "../mcp/usageHeadroom.ts";

interface FsCall {
  readonly method: "makeDirectory" | "readFileString" | "writeFileString" | "rename";
  readonly path: string;
  readonly to?: string;
}

const missingTestFile = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description: "Missing test file.",
  });

const writeTestFailure = (path: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method: "writeFileString",
    pathOrDescriptor: path,
    description: "Simulated write failure.",
  });

/** Mutable knobs shared with the in-memory file system. */
interface FsControl {
  failWrites: boolean;
}

const makeMemoryFileSystem = (
  files: Map<string, string>,
  calls: Array<FsCall>,
  control: FsControl = { failWrites: false },
) => {
  let tempCounter = 0;
  return FileSystem.layerNoop({
    makeTempDirectoryScoped: () => Effect.succeed("/mem/test"),
    makeTempDirectory: () => Effect.sync(() => `/mem/tmp-${++tempCounter}`),
    makeDirectory: (path) =>
      Effect.sync(() => {
        calls.push({ method: "makeDirectory", path: String(path) });
      }),
    readDirectory: (path) =>
      Effect.succeed(
        [...files.keys()]
          .filter(
            (key) =>
              key.startsWith(`${path}/`) && !key.slice(String(path).length + 1).includes("/"),
          )
          .map((key) => key.slice(String(path).length + 1)),
      ),
    readLink: (path) => Effect.fail(missingTestFile("readLink", String(path))),
    readFileString: (path) => {
      const key = String(path);
      calls.push({ method: "readFileString", path: key });
      const hit = files.get(key);
      return hit === undefined
        ? Effect.fail(missingTestFile("readFileString", key))
        : Effect.succeed(hit);
    },
    writeFileString: (path, content) => {
      const key = String(path);
      calls.push({ method: "writeFileString", path: key });
      return control.failWrites
        ? Effect.fail(writeTestFailure(key))
        : Effect.sync(() => {
            files.set(key, String(content));
          });
    },
    rename: (from, to) =>
      Effect.sync(() => {
        const source = String(from);
        const target = String(to);
        calls.push({ method: "rename", path: source, to: target });
        const hit = files.get(source);
        if (hit !== undefined) {
          files.set(target, hit);
          files.delete(source);
        }
      }),
    remove: () => Effect.void,
  });
};

const layerTest = (
  files: Map<string, string>,
  calls: Array<FsCall>,
  control?: FsControl,
  baseDir = "/mem/test",
) =>
  MuseUsage.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest("/mem/cwd", baseDir)),
    Layer.provideMerge(NodePath.layer),
    Layer.provideMerge(makeMemoryFileSystem(files, calls, control)),
  );

const ACCOUNTS_PATH = "/mem/muse-accounts.json";

const accountsJson = encodeJson({
  persona: "nofun",
  accounts: [
    {
      id: "personal",
      label: "Muse Personal",
      expectedEmail: "You@Example.com",
      plan: "Pro",
      cliExecutable: "/x/muse",
      configHome: "/x/c",
      dataHome: "/x/d",
    },
  ],
});

const observation = (observedAtMs: number) => ({
  window: { usedPercent: 40, resetsAtMs: 1_000_000, windowDurationMins: 300 },
  weekly: { usedPercent: 10, resetsAtMs: 9_000_000 },
  observedAtMs,
});

/** Point the service at the in-memory accounts file; restore the env after. */
const useAccountsFile = (files: Map<string, string>, json: string): (() => void) => {
  files.set(ACCOUNTS_PATH, json);
  const previous = process.env.NOFUN_MUSE_ACCOUNTS;
  process.env.NOFUN_MUSE_ACCOUNTS = ACCOUNTS_PATH;
  return () => {
    if (previous === undefined) delete process.env.NOFUN_MUSE_ACCOUNTS;
    else process.env.NOFUN_MUSE_ACCOUNTS = previous;
  };
};

const withService = (
  files: Map<string, string>,
  calls: Array<FsCall>,
  run: (service: MuseUsage.MuseUsage["Service"]) => Effect.Effect<void>,
  control?: FsControl,
  baseDir?: string,
) =>
  Effect.gen(function* () {
    const service = yield* MuseUsage.MuseUsage;
    yield* run(service);
  }).pipe(Effect.scoped, Effect.provide(layerTest(files, calls, control, baseDir)));

describe("MuseUsage passive observations", () => {
  it.effect("starts with no readings and creates no probe state", () =>
    Effect.gen(function* () {
      const files = new Map<string, string>();
      const calls: Array<FsCall> = [];
      const restoreEnv = useAccountsFile(files, accountsJson);
      try {
        yield* withService(files, calls, (service) =>
          Effect.gen(function* () {
            const current = yield* service.current;
            expect(current).toHaveLength(1);
            expect(current[0]).toMatchObject({ id: "muse:personal", accounts: [] });
            expect(current[0]?.error).toBe("Not read yet.");
            // Nothing is probed or persisted until a real observation arrives:
            // no usage files are written and no probe roots are created.
            expect(calls.filter((call) => call.method === "writeFileString")).toEqual([]);
            expect(
              calls.filter((call) => call.method === "makeDirectory" && call.path.includes("muse")),
            ).toEqual([]);
          }),
        );
      } finally {
        restoreEnv();
      }
    }),
  );

  it.effect("records a passive observation and persists only the sanitized reading", () =>
    Effect.gen(function* () {
      const files = new Map<string, string>();
      const calls: Array<FsCall> = [];
      const restoreEnv = useAccountsFile(files, accountsJson);
      try {
        yield* TestClock.setTime(1_000_000);
        yield* withService(files, calls, (service) =>
          Effect.gen(function* () {
            yield* service.recordObservation({
              accountId: "personal",
              usage: observation(900_000),
              signedInAs: "you@example.com",
              cost: "passive",
            });
            const current = yield* service.current;
            expect(current[0]?.checkedAt).toBe("1970-01-01T00:15:00.000Z");
            expect(current[0]?.error).toBeUndefined();
            expect(current[0]?.accounts[0]?.usageLimits.windows).toMatchObject([
              { id: "five_hour", usedPercent: 40 },
              { id: "weekly", usedPercent: 10 },
            ]);

            const writes = calls.filter((call) => call.method === "writeFileString");
            expect(writes).toHaveLength(1);
            const renames = calls.filter((call) => call.method === "rename");
            expect(renames).toHaveLength(1);
            const persistedPath = renames[0]!.to!;
            const persisted = decodeStoredJson(files.get(persistedPath)!);
            expect(persisted).toMatchObject({
              version: 1,
              accountId: "personal",
              sourceId: "muse:personal",
              signedInAs: "you@example.com",
              cost: "passive",
              recordedAtMs: 1_000_000,
            });
            expect(persisted.usage).toMatchObject({ observedAtMs: 900_000 });
            const raw = files.get(persistedPath)!;
            expect(raw).not.toContain("/x/muse");
            expect(raw).not.toContain("/x/c");
            expect(raw).not.toContain("/x/d");
            expect(raw).not.toContain("You@Example.com");
            expect(raw).not.toContain("META_API_KEY");
          }),
        );
      } finally {
        restoreEnv();
      }
    }),
  );

  it.effect("keeps the old successful age when an observation fails", () =>
    Effect.gen(function* () {
      const files = new Map<string, string>();
      const calls: Array<FsCall> = [];
      const restoreEnv = useAccountsFile(files, accountsJson);
      try {
        yield* TestClock.setTime(1_000_000);
        yield* withService(files, calls, (service) =>
          Effect.gen(function* () {
            yield* service.recordObservation({
              accountId: "personal",
              usage: observation(900_000),
              signedInAs: "you@example.com",
            });
            yield* TestClock.setTime(2_000_000);
            yield* service.recordObservation({
              accountId: "personal",
              usage: { nope: true },
            });
            yield* service.recordObservationFailure({
              accountId: "personal",
              cause: new Error("passive reader\nbroke"),
            });
            const current = yield* service.current;
            expect(current[0]?.checkedAt).toBe("1970-01-01T00:15:00.000Z");
            expect(current[0]?.accounts[0]?.usageLimits.windows).toMatchObject([
              { id: "five_hour", usedPercent: 40 },
              { id: "weekly", usedPercent: 10 },
            ]);
            expect(current[0]?.error).toBe("The Muse observation failed.");
            expect(encodeJson(current)).not.toContain("passive reader");
          }),
        );
      } finally {
        restoreEnv();
      }
    }),
  );

  it.effect("ignores observations for unknown accounts", () =>
    Effect.gen(function* () {
      const files = new Map<string, string>();
      const calls: Array<FsCall> = [];
      const restoreEnv = useAccountsFile(files, accountsJson);
      try {
        yield* withService(files, calls, (service) =>
          Effect.gen(function* () {
            yield* service.recordObservation({ accountId: "ghost", usage: observation(1) });
            yield* service.recordObservationFailure({ accountId: "ghost", cause: "boom" });
            const current = yield* service.current;
            expect(current).toHaveLength(1);
            expect(current[0]).toMatchObject({ id: "muse:personal", accounts: [] });
            expect(calls.filter((call) => call.method === "writeFileString")).toEqual([]);
          }),
        );
      } finally {
        restoreEnv();
      }
    }),
  );

  it.effect("publishes observations over the stream", () =>
    Effect.gen(function* () {
      const files = new Map<string, string>();
      const calls: Array<FsCall> = [];
      const restoreEnv = useAccountsFile(files, accountsJson);
      try {
        yield* TestClock.setTime(1_000_000);
        yield* withService(files, calls, (service) =>
          Effect.gen(function* () {
            const waiter = yield* Effect.forkChild(
              service.streamChanges.pipe(
                Stream.filter((snapshots) =>
                  snapshots.some(
                    (snapshot) => snapshot.id === "muse:personal" && snapshot.accounts.length > 0,
                  ),
                ),
                Stream.take(1),
                Stream.runCollect,
              ),
            );
            yield* service.recordObservation({
              accountId: "personal",
              usage: observation(900_000),
              signedInAs: "you@example.com",
            });
            const collected = yield* Fiber.join(waiter);
            expect(Array.from(collected)).toHaveLength(1);
          }),
        );
      } finally {
        restoreEnv();
      }
    }),
  );

  it.effect("restores the sanitized observation on restart and rejects wrong bindings", () =>
    Effect.gen(function* () {
      const files = new Map<string, string>();
      const calls: Array<FsCall> = [];
      const restoreEnv = useAccountsFile(files, accountsJson);
      try {
        yield* TestClock.setTime(1_000_000);
        yield* withService(files, calls, (service) =>
          Effect.gen(function* () {
            yield* service.recordObservation({
              accountId: "personal",
              usage: observation(900_000),
              signedInAs: "you@example.com",
            });
          }),
        );
        // Restart after the clock moves on: the restored reading keeps its age.
        yield* TestClock.setTime(5_000_000);
        yield* withService(files, calls, (service) =>
          Effect.gen(function* () {
            const current = yield* service.current;
            expect(current[0]?.checkedAt).toBe("1970-01-01T00:15:00.000Z");
            expect(current[0]?.accounts[0]?.usageLimits.windows).toMatchObject([
              { id: "five_hour", usedPercent: 40 },
              { id: "weekly", usedPercent: 10 },
            ]);
          }),
        );
        // A stored file bound to another account is rejected, not trusted.
        const storedPath = calls.find((call) => call.method === "rename")!.to!;
        const tampered = {
          ...decodeStoredJson(files.get(storedPath)!),
          accountId: "other",
          sourceId: "muse:other",
        };
        files.set(storedPath, encodeJson(tampered));
        yield* withService(files, calls, (service) =>
          Effect.gen(function* () {
            const current = yield* service.current;
            expect(current[0]).toMatchObject({ id: "muse:personal", accounts: [] });
            expect(current[0]?.error).toBe("The saved observation is not bound to this account.");
          }),
        );
      } finally {
        restoreEnv();
      }
    }),
  );

  it.effect("fails closed on unknown or wrong login and never leaks the secret canary", () =>
    Effect.gen(function* () {
      const files = new Map<string, string>();
      const calls: Array<FsCall> = [];
      const restoreEnv = useAccountsFile(files, accountsJson);
      try {
        yield* TestClock.setTime(1_000_000);
        yield* withService(files, calls, (service) =>
          Effect.gen(function* () {
            yield* service.recordObservation({
              accountId: "personal",
              usage: observation(900_000),
            });
            let current = yield* service.current;
            expect(current[0]).toMatchObject({ accounts: [] });
            expect(current[0]?.error).toBe(
              "The Muse observation did not report a signed-in login.",
            );
            yield* service.recordObservation({
              accountId: "personal",
              usage: observation(900_000),
              signedInAs: "other@example.com",
            });
            current = yield* service.current;
            expect(current[0]?.error).toBe(
              "The Muse observation is signed in as a different login.",
            );
            expect(encodeJson(current)).not.toContain("other@example.com");
            yield* service.recordObservationFailure({
              accountId: "personal",
              cause: new Error("SECRET_CANARY_123 token=hunter2 /home/user/auth.json"),
            });
            current = yield* service.current;
            expect(current[0]?.error).toBe("The Muse observation failed.");
            expect(current[0]?.checkedAt).toBe("1970-01-01T00:16:40.000Z");
            expect(encodeJson(current)).not.toContain("SECRET_CANARY_123");
            expect(encodeJson(current)).not.toContain("hunter2");
            expect(calls.filter((c) => c.method === "rename")).toEqual([]);
          }),
        );
      } finally {
        restoreEnv();
      }
    }),
  );

  it.effect("rejects stale and future observations and defaults cost to unknown", () =>
    Effect.gen(function* () {
      const files = new Map<string, string>();
      const calls: Array<FsCall> = [];
      const restoreEnv = useAccountsFile(files, accountsJson);
      try {
        yield* TestClock.setTime(1_000_000);
        yield* withService(files, calls, (service) =>
          Effect.gen(function* () {
            yield* service.recordObservation({
              accountId: "personal",
              usage: observation(900_000),
              signedInAs: "you@example.com",
            });
            const renames = calls.filter((c) => c.method === "rename");
            expect(decodeStoredJson(files.get(renames.at(-1)!.to!)!)).toMatchObject({
              cost: "unknown",
            });
            yield* TestClock.setTime(1_100_000);
            yield* service.recordObservation({
              accountId: "personal",
              usage: observation(800_000),
              signedInAs: "you@example.com",
            });
            let current = yield* service.current;
            expect(current[0]?.checkedAt).toBe("1970-01-01T00:15:00.000Z");
            expect(current[0]?.error).toBe(
              "The Muse observation is older than the latest reading.",
            );
            yield* service.recordObservation({
              accountId: "personal",
              usage: observation(9_000_000),
              signedInAs: "you@example.com",
            });
            current = yield* service.current;
            expect(current[0]?.checkedAt).toBe("1970-01-01T00:15:00.000Z");
            expect(current[0]?.error).toBe("The Muse observation is dated in the future.");
          }),
        );
      } finally {
        restoreEnv();
      }
    }),
  );

  it.effect("serializes concurrent observations and shows unpersisted readings as unsaved", () =>
    Effect.gen(function* () {
      const files = new Map<string, string>();
      const calls: Array<FsCall> = [];
      const control: FsControl = { failWrites: false };
      const twoAccounts = encodeJson({
        persona: "nofun",
        accounts: [
          { id: "personal", label: "Muse Personal", expectedEmail: "you@example.com" },
          { id: "second", label: "Muse Second" },
        ],
      });
      const restoreEnv = useAccountsFile(files, twoAccounts);
      try {
        yield* TestClock.setTime(1_000_000);
        yield* withService(
          files,
          calls,
          (service) =>
            Effect.gen(function* () {
              yield* Effect.all(
                [
                  service.recordObservation({
                    accountId: "personal",
                    usage: observation(900_000),
                    signedInAs: "you@example.com",
                  }),
                  service.recordObservation({ accountId: "second", usage: observation(900_000) }),
                  service.recordObservationFailure({ accountId: "second", cause: "boom" }),
                ],
                { concurrency: "unbounded" },
              );
              const current = yield* service.current;
              expect(current).toHaveLength(2);
              expect(current.find((s) => s.id === "muse:personal")?.accounts).toHaveLength(1);
              expect(current.find((s) => s.id === "muse:second")?.accounts).toHaveLength(1);
            }),
          control,
        );
        // A failed persist is visible and does not survive a restart.
        control.failWrites = true;
        yield* withService(
          files,
          calls,
          (service) =>
            Effect.gen(function* () {
              yield* TestClock.setTime(2_000_000);
              yield* service.recordObservation({
                accountId: "second",
                usage: observation(1_500_000),
              });
              const current = yield* service.current;
              const second = current.find((s) => s.id === "muse:second");
              expect(second?.accounts).toHaveLength(1);
              expect(second?.error).toBe("The Muse observation could not be saved.");
            }),
          control,
        );
        control.failWrites = false;
        yield* withService(files, calls, (service) =>
          Effect.gen(function* () {
            const current = yield* service.current;
            const second = current.find((s) => s.id === "muse:second");
            // Restart restores only the persisted 900_000 reading, not 1_500_000.
            expect(second?.checkedAt).toBe("1970-01-01T00:15:00.000Z");
          }),
        );
        // Removing an account from the file removes its snapshot on reload.
        files.set(
          ACCOUNTS_PATH,
          encodeJson({
            persona: "nofun",
            accounts: [{ id: "second", label: "Muse Second" }],
          }),
        );
        yield* withService(files, calls, (service) =>
          Effect.gen(function* () {
            const current = yield* service.current;
            expect(current.map((s) => s.id)).toEqual(["muse:second"]);
          }),
        );
      } finally {
        restoreEnv();
      }
    }),
  );

  it.effect("resolves the registry and observations from the T3 home in use", () =>
    Effect.gen(function* () {
      const previous = process.env.NOFUN_MUSE_ACCOUNTS;
      delete process.env.NOFUN_MUSE_ACCOUNTS;
      try {
        const m1Home = "/m1/.nofun-t3-m1/t/aaa";
        const files = new Map<string, string>();
        const calls: Array<FsCall> = [];
        files.set(`${m1Home}/muse-accounts.json`, accountsJson);
        const configured = decodeAccountsJson(accountsJson).accounts[0]!;
        files.set(
          `${m1Home}/muse-usage-observations/personal.900000.00000000-0000-4000-8000-000000000000.json`,
          encodeJson({
            version: 1,
            accountId: "personal",
            sourceId: "muse:personal",
            accountBinding: museAccountBinding(configured),
            signedInAs: "you@example.com",
            cost: "passive",
            recordedAtMs: 950_000,
            usage: observation(900_000),
          }),
        );
        yield* TestClock.setTime(1_000_000);
        yield* withService(
          files,
          calls,
          (service) =>
            Effect.gen(function* () {
              const current = yield* service.current;
              expect(current.map((s) => s.id)).toEqual(["muse:personal"]);
              expect(current[0]?.accounts).toHaveLength(1);
              expect(current[0]?.accounts[0]?.usageLimits.windows).toMatchObject([
                { usedPercent: 40 },
                { usedPercent: 10 },
              ]);
              expect(calls.some((call) => call.path === `${m1Home}/muse-accounts.json`)).toBe(true);
            }),
          undefined,
          m1Home,
        );
      } finally {
        if (previous === undefined) delete process.env.NOFUN_MUSE_ACCOUNTS;
        else process.env.NOFUN_MUSE_ACCOUNTS = previous;
      }
    }),
  );
});

describe("native useful-work observations", () => {
  const account = decodeAccountsJson(accountsJson).accounts[0]!;
  const keptPath =
    "/mem/muse-usage-observations/personal.900000.00000000-0000-4000-8000-000000000000.json";
  const kept = (overrides: Record<string, unknown> = {}) =>
    encodeJson({
      version: 1,
      accountId: "personal",
      sourceId: "muse:personal",
      accountBinding: museAccountBinding(account),
      signedInAs: "you@example.com",
      cost: "passive",
      recordedAtMs: 950_000,
      usage: {
        ...observation(900_000),
        window: { usedPercent: 0, resetsAtMs: 1_100_000, windowDurationMins: 300 },
        weekly: { usedPercent: 100, resetsAtMs: 9_000_000 },
      },
      ...overrides,
    });

  it.effect(
    "current consumes a kept native observation and restart retains age and agent-visible exhaustion",
    () =>
      Effect.gen(function* () {
        const files = new Map<string, string>();
        const calls: Array<FsCall> = [];
        const restoreEnv = useAccountsFile(files, accountsJson);
        try {
          yield* TestClock.setTime(1_000_000);
          yield* withService(files, calls, (service) =>
            Effect.gen(function* () {
              expect((yield* service.current)[0]?.accounts).toEqual([]);
              files.set(keptPath, kept());
              const source = (yield* service.current)[0]!;
              expect(source.accounts[0]?.usageLimits.windows).toMatchObject([
                { usedPercent: 0 },
                { usedPercent: 100 },
              ]);
              expect(usageHeadroom(source.accounts[0]?.usageLimits, 1_000_000).headroom).toBe(
                "exhausted",
              );
              const writes = calls.filter((call) => call.method === "writeFileString").length;
              yield* service.current;
              expect(calls.filter((call) => call.method === "writeFileString")).toHaveLength(
                writes,
              );
            }),
          );
          files.delete(keptPath); // Server's own sanitized copy survives independently.
          yield* TestClock.setTime(1_200_000);
          yield* withService(files, calls, (service) =>
            Effect.gen(function* () {
              const source = (yield* service.current)[0]!;
              expect(source.checkedAt).toBe("1970-01-01T00:15:00.000Z");
              // A passed reset never becomes a replenished pool.
              expect(usageHeadroom(source.accounts[0]?.usageLimits, 1_200_000).headroom).toBe(
                "unknown",
              );
              expect(usageHeadroom(source.accounts[0]?.usageLimits, 3_000_000).headroom).toBe(
                "unknown",
              );
            }),
          );
        } finally {
          restoreEnv();
        }
      }),
  );

  it.effect(
    "rejects wrong account, source, roots, identity, provenance, future data and replay",
    () =>
      Effect.gen(function* () {
        const files = new Map<string, string>();
        const calls: Array<FsCall> = [];
        const restoreEnv = useAccountsFile(files, accountsJson);
        try {
          yield* TestClock.setTime(1_000_000);
          yield* withService(files, calls, (service) =>
            Effect.gen(function* () {
              for (const overrides of [
                { accountId: "other" },
                { sourceId: "muse:other" },
                { accountBinding: museAccountBinding({ ...account, dataHome: "/another" }) },
                { signedInAs: "other@example.com" },
                { signedInAs: "" },
                { cost: "model_turn" },
                { recordedAtMs: 1_100_000 },
                { usage: observation(1_100_000) },
              ]) {
                files.set(keptPath, kept(overrides));
                expect((yield* service.current)[0]?.accounts).toEqual([]);
              }
              files.set(keptPath, kept());
              const original = yield* service.current;
              files.set(keptPath, kept({ usage: observation(899_000) }));
              expect(yield* service.current).toEqual(original);
              files.set(keptPath, kept({ usage: observation(900_000) }));
              expect(yield* service.current).toEqual(original);
            }),
          );
        } finally {
          restoreEnv();
        }
      }),
  );
});
