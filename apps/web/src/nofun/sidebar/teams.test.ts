import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  pickLatestThread,
  sidebarTeams,
  threadActivityMs,
  threadsOfTeam,
  threadWorkCounts,
} from "./teams.ts";

const catches = { id: "catches", label: "CATCHES" } as never;

describe("sidebarTeams", () => {
  it("lists No Fun first and de-duplicates environments of one team", () => {
    expect(
      sidebarTeams([
        { persona: catches },
        { persona: undefined },
        { persona: catches },
        { persona: { id: "nofun", label: "No Fun" } as never },
      ]),
    ).toEqual([
      { id: "nofun", label: "No Fun" },
      { id: "catches", label: "CATCHES" },
    ]);
  });

  it("is a single team when only one world is connected", () => {
    expect(sidebarTeams([{ persona: catches }])).toEqual([{ id: "catches", label: "CATCHES" }]);
  });
});

describe("threadsOfTeam", () => {
  const a = "env-a" as EnvironmentId;
  const b = "env-b" as EnvironmentId;
  const threads = [
    { id: "1", environmentId: a },
    { id: "2", environmentId: b },
    { id: "3", environmentId: a },
    { id: "4", environmentId: "env-unknown" as EnvironmentId },
  ];
  const teamByEnvironment = new Map<EnvironmentId, string>([
    [a, "nofun"],
    [b, "catches"],
  ]);

  it("keeps only the team's threads; an unknown environment counts as No Fun", () => {
    expect(threadsOfTeam(threads, "nofun", teamByEnvironment).map((t) => t.id)).toEqual([
      "1",
      "3",
      "4",
    ]);
    expect(threadsOfTeam(threads, "catches", teamByEnvironment).map((t) => t.id)).toEqual(["2"]);
  });

  it("keeps everything without a team", () => {
    expect(threadsOfTeam(threads, null, teamByEnvironment)).toBe(threads);
  });
});

describe("latest thread", () => {
  const thread = (
    id: string,
    input: { user?: string; run?: string; created?: string },
  ): Parameters<typeof pickLatestThread>[0][number] & { id: string } =>
    ({
      id,
      latestUserMessageAt: input.user ?? null,
      latestRun:
        input.run === undefined
          ? null
          : {
              runId: "r",
              status: "completed",
              requestedAt: null,
              startedAt: null,
              completedAt: input.run,
            },
      createdAt: input.created ?? "2026-01-01T00:00:00.000Z",
    }) as never;

  it("uses the later of the user's message and the run's activity", () => {
    const quiet = thread("quiet", { user: "2026-10-01T10:00:00.000Z" });
    const agent = thread("agent", {
      user: "2026-10-01T09:00:00.000Z",
      run: "2026-10-01T12:00:00.000Z",
    });
    expect(pickLatestThread([quiet, agent])?.id).toBe("agent");
    expect(threadActivityMs(agent)).toBe(Date.parse("2026-10-01T12:00:00.000Z"));
  });

  it("falls back to creation time and is null for nothing", () => {
    const old = thread("old", { created: "2026-02-01T00:00:00.000Z" });
    const fresh = thread("fresh", { created: "2026-03-01T00:00:00.000Z" });
    expect(pickLatestThread([old, fresh])?.id).toBe("fresh");
    expect(pickLatestThread([])).toBeNull();
  });

  it("counts a parent's most recent child activity as its own", () => {
    const parent = thread("parent", { user: "2026-10-01T10:00:00.000Z" });
    const other = thread("other", { user: "2026-10-01T11:00:00.000Z" });
    const child = thread("child", { user: "2026-10-01T12:00:00.000Z" });
    const childrenByParentKey = new Map([["parent", [child]]]);
    const subagents = { getKey: (candidate: typeof parent) => candidate.id, childrenByParentKey };
    expect(pickLatestThread([parent, other])?.id).toBe("other");
    expect(pickLatestThread([parent, other], subagents)?.id).toBe("parent");
  });

  it("ignores children grouped under another parent", () => {
    const parent = thread("parent", { user: "2026-10-01T10:00:00.000Z" });
    const other = thread("other", { user: "2026-10-01T11:00:00.000Z" });
    const elsewhere = thread("elsewhere", { user: "2026-10-01T12:00:00.000Z" });
    const childrenByParentKey = new Map([["someone-else", [elsewhere]]]);
    const subagents = { getKey: (candidate: typeof parent) => candidate.id, childrenByParentKey };
    expect(pickLatestThread([parent, other], subagents)?.id).toBe("other");
  });
});

describe("threadWorkCounts", () => {
  it("reads absent fields as none", () => {
    expect(threadWorkCounts({})).toEqual({ subagents: 0, background: 0 });
    expect(threadWorkCounts({ activeSubagentCount: 2, activeBackgroundTaskCount: 1 })).toEqual({
      subagents: 2,
      background: 1,
    });
  });
});
