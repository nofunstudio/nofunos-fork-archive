// @effect-diagnostics nodeBuiltinImport:off -- passive OS measurements, bounded commands, no provider turns.
import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import type { OrchestratorMcpHostCapacity } from "@t3tools/contracts";
import type { MissionAdmissionHostFacts } from "./MissionAdmission.ts";

const exec = promisify(execFile);
const DISK_FLOOR_BYTES = 5 * 1024 ** 3;
const SAMPLE_TTL_MS = 5_000;

const command = (file: string, args: string[]) =>
  exec(file, args, { timeout: 1_000, maxBuffer: 64 * 1024, encoding: "utf8" });

function cpuCounters() {
  const cpus = OS.cpus();
  return {
    count: cpus.length,
    idle: cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0),
    total: cpus.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0),
  };
}

async function memory(): Promise<OrchestratorMcpHostCapacity["memory"]> {
  const totalBytes = OS.totalmem();
  if (process.platform === "darwin") {
    const [vm, level] = await Promise.allSettled([
      command("/usr/bin/vm_stat", []),
      command("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
    ]);
    const output = vm.status === "fulfilled" ? vm.value.stdout : "";
    const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
    const pages = ["free", "inactive", "speculative"].map((name) =>
      Number(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, "m").exec(output)?.[1]),
    );
    const available = pages.reduce((a, b) => a + b, 0) * pageSize;
    const pressureLevel = level.status === "fulfilled" ? Number(level.value.stdout.trim()) : NaN;
    return {
      totalBytes,
      availableBytes:
        Number.isSafeInteger(available) && available >= 0 ? Math.min(totalBytes, available) : null,
      pressure:
        pressureLevel === 1
          ? "normal"
          : pressureLevel === 2
            ? "warning"
            : pressureLevel === 4
              ? "critical"
              : "unknown",
    };
  }
  if (process.platform === "linux") {
    const [info, psi] = await Promise.allSettled([
      readFile("/proc/meminfo", "utf8"),
      readFile("/proc/pressure/memory", "utf8"),
    ]);
    const available =
      info.status === "fulfilled"
        ? Number(/^MemAvailable:\s+(\d+)\s+kB$/m.exec(info.value)?.[1]) * 1024
        : NaN;
    const stall =
      psi.status === "fulfilled" ? Number(/^full avg10=([\d.]+)/m.exec(psi.value)?.[1]) : NaN;
    return {
      totalBytes,
      availableBytes: Number.isFinite(available) ? available : null,
      pressure:
        !Number.isFinite(stall) || !Number.isFinite(available)
          ? "unknown"
          : stall >= 5 || available / totalBytes < 0.03
            ? "critical"
            : stall >= 1 || available / totalBytes < 0.08
              ? "warning"
              : "normal",
    };
  }
  // Free RAM is useful telemetry, but does not establish OS memory pressure.
  return { totalBytes, availableBytes: OS.freemem(), pressure: "unknown" };
}

async function bootId(): Promise<string | null> {
  try {
    const value =
      process.platform === "darwin"
        ? (await command("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"])).stdout
        : process.platform === "linux"
          ? await readFile("/proc/sys/kernel/random/boot_id", "utf8")
          : "";
    return value.trim() || null;
  } catch {
    return null;
  }
}

async function probeBuildLock(
  file: string,
  args: string[],
): Promise<OrchestratorMcpHostCapacity["buildLock"]["state"]> {
  try {
    await command(file, args);
    return "available";
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === 75
      ? "held"
      : "unknown";
  }
}

async function buildLock(path: string): Promise<OrchestratorMcpHostCapacity["buildLock"]> {
  // Existence cannot establish ownership. Briefly try the same kernel locks
  // heavy builds use, release on exit, and preserve their inodes with -k.
  let slots: OrchestratorMcpHostCapacity["buildLock"]["state"][];
  if (process.platform === "darwin") {
    // The macOS lockf helper has two slots; Linux's flock backend has one.
    slots = await Promise.all(
      [path, Path.join(OS.homedir(), ".nofun-heavy-build-slot2.lock")].map((slot) =>
        probeBuildLock("/usr/bin/lockf", ["-t", "0", "-k", slot, "/usr/bin/true"]),
      ),
    );
  } else if (process.platform === "linux") {
    slots = [await probeBuildLock("flock", ["-n", "-E", "75", path, "true"])];
  } else {
    return { path, state: "unknown" };
  }
  return {
    path,
    state: slots.includes("available")
      ? "available"
      : slots.every((state) => state === "held")
        ? "held"
        : "unknown",
  };
}

async function sample(
  diskPath: string,
  observedAtMs: number,
): Promise<OrchestratorMcpHostCapacity> {
  const before = cpuCounters();
  const [mem, boot, lock, disk] = await Promise.all([
    memory(),
    bootId(),
    buildLock(Path.join(OS.homedir(), ".nofun-heavy-build.lock")),
    statfs(diskPath)
      .then((fs) => fs.bavail * fs.bsize)
      .catch(() => null),
    setTimeout(200),
  ]);
  const after = cpuCounters();
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  const utilization =
    before.count === after.count && total > 0 && idle >= 0 && idle <= total
      ? 1 - idle / total
      : null;
  const loadAverage1m = OS.loadavg()[0] ?? 0;
  // Do not reject a transient busy sample alone: the one-minute runnable
  // load must also fill the logical CPUs. Thresholds are per-host fractions.
  const saturated =
    utilization === null || after.count === 0
      ? null
      : utilization >= 0.95 && loadAverage1m / after.count >= 0.9;
  const reasons: string[] = [];
  if (boot === null) reasons.push("boot_identity_unknown");
  if (saturated === null) reasons.push("cpu_unknown");
  else if (saturated) reasons.push("cpu_saturated");
  if (mem.pressure !== "normal") reasons.push(`memory_${mem.pressure}`);
  if (mem.availableBytes === null) reasons.push("available_memory_unknown");
  if (disk === null || !Number.isFinite(disk)) reasons.push("disk_unknown");
  else if (disk < DISK_FLOOR_BYTES) reasons.push("disk_below_floor");
  // Build slots are telemetry only: heavy builds queue themselves, while
  // non-building agents may run whenever the host resource gates allow it.
  return {
    hostId: OS.hostname(),
    bootId: boot,
    observedAtMs,
    cpu: { utilization, count: after.count, loadAverage1m, saturated },
    memory: mem,
    disk: { path: diskPath, availableBytes: disk, floorBytes: DISK_FLOOR_BYTES },
    buildLock: lock,
    ready: reasons.length === 0,
    reasons,
  };
}

// Coalesce simultaneous capability/admission reads; no polling or paid probe.
let cached:
  | { path: string; startedAt: number; value: Promise<OrchestratorMcpHostCapacity> }
  | undefined;
export function readExecutionCapacity(
  diskPath: string,
  nowMs: number,
): Promise<OrchestratorMcpHostCapacity> {
  if (
    !cached ||
    cached.path !== diskPath ||
    nowMs < cached.startedAt ||
    nowMs - cached.startedAt >= SAMPLE_TTL_MS
  ) {
    cached = { path: diskPath, startedAt: nowMs, value: sample(diskPath, nowMs) };
  }
  return cached.value;
}

export function withExecutionCapacity(
  host: MissionAdmissionHostFacts,
  capacity: OrchestratorMcpHostCapacity,
): MissionAdmissionHostFacts {
  const sameHost = host.hostId === capacity.hostId && host.bootId === capacity.bootId;
  return {
    ...host,
    buildObserved: sameHost && host.buildObserved,
    toolchainObserved: sameHost && host.toolchainObserved,
    hostId: capacity.hostId,
    bootId: capacity.bootId ?? "",
    observedAtMs: Math.min(host.observedAtMs, capacity.observedAtMs),
    ready: sameHost && host.ready && capacity.ready,
    pressureObserved:
      capacity.cpu.saturated !== null &&
      capacity.memory.pressure !== "unknown" &&
      capacity.memory.availableBytes !== null &&
      capacity.disk.availableBytes !== null,
    pressureAcceptable: capacity.ready,
    capacity,
  };
}
