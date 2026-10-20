// @effect-diagnostics nodeBuiltinImport:off -- Mock OS boundaries without probing the shared host's locks or pressure.
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import type * as NodeFS from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { readExecutionCapacity, withExecutionCapacity } from "./ExecutionCapacity.ts";
import type { MissionAdmissionHostFacts } from "./MissionAdmission.ts";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  locks: ["available", "available"] as string[],
  pressure: "1",
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return {
    ...original,
    execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.command }),
  };
});
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  cpus: vi.fn(),
  loadavg: vi.fn(),
  homedir: () => "/test-home",
  hostname: () => "test-host",
  totalmem: () => 16 * 1024 ** 3,
}));
vi.mock("node:fs/promises", () => ({ statfs: vi.fn(), readFile: vi.fn() }));
vi.mock("node:timers/promises", () => ({ setTimeout: () => Promise.resolve() }));

const host: MissionAdmissionHostFacts = {
  hostId: "test-host",
  bootId: "test-boot",
  observedAtMs: 1_000,
  ready: true,
  buildObserved: true,
  buildOk: true,
  toolchainObserved: true,
  toolchainOk: true,
  pressureObserved: true,
  pressureAcceptable: true,
};
let sampleId = 0;
const sample = () => readExecutionCapacity(`/test-disk-${sampleId++}`, 1_000);
const cpu = (idle: number, user: number) => [
  { model: "test", speed: 1, times: { idle, user, sys: 0, nice: 0, irq: 0 } },
];

beforeEach(() => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  mocks.locks = ["available", "available"];
  mocks.pressure = "1";
  mocks.command.mockImplementation(async (file: string, args: string[]) => {
    if (file === "/usr/bin/lockf" || file === "flock") {
      const slot = args.some((arg) => arg.endsWith("-slot2.lock")) ? 1 : 0;
      const state = mocks.locks[slot];
      if (state !== "available")
        throw Object.assign(new Error("probe failed"), {
          code: state === "held" ? 75 : "ENOENT",
        });
      return { stdout: "", stderr: "" };
    }
    if (file === "/usr/bin/vm_stat")
      return {
        stdout:
          "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 100000.\nPages inactive: 100000.\nPages speculative: 100000.",
        stderr: "",
      };
    return {
      stdout: args.includes("kern.bootsessionuuid") ? "test-boot" : mocks.pressure,
      stderr: "",
    };
  });
  vi.mocked(NodeOS.cpus)
    .mockReset()
    .mockReturnValueOnce(cpu(100, 100))
    .mockReturnValue(cpu(180, 120));
  vi.mocked(NodeOS.loadavg).mockReturnValue([0.1, 0.1, 0.1]);
  vi.mocked(NodeFSP.statfs)
    .mockReset()
    .mockResolvedValue({ bavail: 10 * 1024 ** 3, bsize: 1 } as NodeFS.StatsFs);
  vi.mocked(NodeFSP.readFile).mockImplementation(async (path) => {
    if (path === "/proc/sys/kernel/random/boot_id") return "test-boot";
    if (path === "/proc/meminfo") return "MemAvailable: 8388608 kB";
    return "full avg10=0.00 avg60=0.00 avg300=0.00 total=0";
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("build slot telemetry", () => {
  it.each([
    ["available", "available", "available"],
    ["held", "available", "available"],
    ["available", "held", "available"],
    ["held", "held", "held"],
    ["unknown", "available", "available"],
    ["available", "unknown", "available"],
    ["held", "unknown", "unknown"],
    ["unknown", "held", "unknown"],
    ["unknown", "unknown", "unknown"],
  ])("macOS slots %s/%s report %s without blocking admission", async (first, second, state) => {
    mocks.locks = [first, second];
    const capacity = await sample();
    expect(capacity.buildLock).toEqual({ path: "/test-home/.nofun-heavy-build.lock", state });
    expect(capacity.ready).toBe(true);
    expect(capacity.reasons).toEqual([]);
    expect(withExecutionCapacity(host, capacity)).toMatchObject({
      ready: true,
      pressureObserved: true,
      pressureAcceptable: true,
    });
  });

  it.each(["available", "held", "unknown"])(
    "Linux reports its single flock slot as %s",
    async (state) => {
      vi.stubGlobal("process", { ...process, platform: "linux" });
      mocks.locks = [state, "available"];
      const capacity = await sample();
      expect(capacity.buildLock.state).toBe(state);
      expect(capacity.ready).toBe(true);
      expect(withExecutionCapacity(host, capacity).pressureObserved).toBe(true);
    },
  );
});

describe("resource pressure gates", () => {
  it("still blocks saturated CPUs", async () => {
    vi.mocked(NodeOS.cpus)
      .mockReset()
      .mockReturnValueOnce(cpu(100, 100))
      .mockReturnValue(cpu(100, 200));
    vi.mocked(NodeOS.loadavg).mockReturnValue([1, 1, 1]);
    const capacity = await sample();
    expect(capacity.reasons).toEqual(["cpu_saturated"]);
    expect(withExecutionCapacity(host, capacity)).toMatchObject({
      ready: false,
      pressureAcceptable: false,
    });
  });

  it("still blocks unknown CPU observations", async () => {
    vi.mocked(NodeOS.cpus).mockReset().mockReturnValue(cpu(100, 100));
    const capacity = await sample();
    expect(capacity.ready).toBe(false);
    expect(capacity.reasons).toEqual(["cpu_unknown"]);
    expect(withExecutionCapacity(host, capacity).pressureObserved).toBe(false);
  });

  it.each([
    ["2", "memory_warning"],
    ["4", "memory_critical"],
    ["", "memory_unknown"],
  ])("still blocks memory pressure %s", async (level, reason) => {
    mocks.pressure = level;
    const capacity = await sample();
    expect(capacity.ready).toBe(false);
    expect(capacity.reasons).toEqual([reason]);
  });

  it("still blocks disks below the floor", async () => {
    vi.mocked(NodeFSP.statfs).mockResolvedValue({ bavail: 1024 ** 3, bsize: 1 } as NodeFS.StatsFs);
    const capacity = await sample();
    expect(capacity.ready).toBe(false);
    expect(capacity.reasons).toEqual(["disk_below_floor"]);
  });

  it("still blocks unknown disk observations", async () => {
    vi.mocked(NodeFSP.statfs).mockRejectedValue(new Error("unavailable"));
    const capacity = await sample();
    expect(capacity.ready).toBe(false);
    expect(capacity.reasons).toEqual(["disk_unknown"]);
    expect(withExecutionCapacity(host, capacity).pressureObserved).toBe(false);
  });
});
