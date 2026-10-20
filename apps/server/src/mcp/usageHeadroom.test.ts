import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { usageHeadroom } from "./usageHeadroom.ts";

const NOW = Date.parse("2026-10-08T00:00:00.000Z");
const at = (minutes: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + minutes * 60_000));

const window = (
  kind: ServerProviderUsageWindow["kind"],
  usedPercent: number,
  resetsInMinutes: number,
  label: string = kind,
  extra?: Partial<ServerProviderUsageWindow>,
): ServerProviderUsageWindow => ({
  id: `${kind}-${label}`,
  kind,
  label,
  usedPercent,
  resetsAt: at(resetsInMinutes),
  ...extra,
});

const limits = (...windows: ServerProviderUsageWindow[]) => ({
  checkedAt: at(0),
  windows,
});

const staleLimits = (...windows: ServerProviderUsageWindow[]) => ({
  // Observed two hours ago; any reset since then has passed unseen.
  checkedAt: at(-120),
  windows,
});

describe("usageHeadroom", () => {
  it("flags a nearly spent weekly window as low and says when it resets", () => {
    const result = usageHeadroom(
      limits(window("session", 4, 200), window("weekly", 96, 3 * 24 * 60)),
      NOW,
    );
    expect(result.headroom).toBe("low");
    expect(result.summary).toBe(
      "5h 96% left (resets in 3h 20m) · weekly 4% left (resets in 3d 0h)",
    );
  });

  it("treats a spent pool as exhausted and names repeated monthly pools", () => {
    const result = usageHeadroom(
      limits(
        window("monthly", 100, 600, "Cursor Models"),
        window("monthly", 100, 600, "Other Models"),
      ),
      NOW,
    );
    expect(result.headroom).toBe("exhausted");
    expect(result.summary).toBe(
      "Cursor Models 0% left (resets in 10h 0m) · Other Models 0% left (resets in 10h 0m)",
    );
  });

  it("keeps a spent pool exhausted even when it resets in 40 minutes", () => {
    expect(usageHeadroom(limits(window("monthly", 100, 40)), NOW).headroom).toBe("exhausted");
  });

  it("keeps a low pool low even when it resets in 40 minutes", () => {
    const result = usageHeadroom(limits(window("weekly", 90, 40)), NOW);
    expect(result.headroom).toBe("low");
    expect(result.summary).toBe("weekly 10% left (resets in 40m)");
  });

  it("never rounds 99.6% used into exhaustion", () => {
    const result = usageHeadroom(limits(window("weekly", 99.6, 600)), NOW);
    expect(result.headroom).toBe("low");
    expect(result.summary).toBe("weekly 0% left (resets in 10h 0m)");
  });

  it("reads a reset that passed since the last check as stale, not replenished", () => {
    // Healthy numbers, but the reset passed an hour ago and nobody has
    // observed the window since: this may be empty or full.
    const result = usageHeadroom(staleLimits(window("session", 10, -60)), NOW);
    expect(result).toEqual({
      headroom: "unknown",
      summary: "usage observation is stale or unavailable",
    });
  });

  it("trusts a reset that passed when the observation postdates it", () => {
    const result = usageHeadroom(
      { checkedAt: at(-30), windows: [window("session", 10, -60)] },
      NOW,
    );
    expect(result.headroom).toBe("ok");
  });

  it("gates unscoped windows whatever their label punctuation is", () => {
    const result = usageHeadroom(
      limits(window("weekly", 10, 900), window("weekly", 99, 900, "Weekly · Opus")),
      NOW,
    );
    expect(result.headroom).toBe("low");
  });

  it("gates a model-scoped window only for its model", () => {
    const scoped = window("weekly", 100, 900, "Weekly · Fable", {
      id: "seven_day_fable",
      appliesToModel: "Fable",
    });
    const account = limits(window("session", 4, 200, "session"), window("weekly", 10, 900));
    const withScoped = { checkedAt: at(0), windows: [...account.windows, scoped] };
    // The spent model window blocks its own model and the model-absent call.
    expect(usageHeadroom(withScoped, NOW, { model: "Fable" }).headroom).toBe("exhausted");
    expect(usageHeadroom(withScoped, NOW, { model: "claude-fable-5-1" }).headroom).toBe(
      "exhausted",
    );
    expect(usageHeadroom(withScoped, NOW, { model: "claude-sonnet-5-5" }).headroom).toBe("ok");
    expect(usageHeadroom(withScoped, NOW).headroom).toBe("exhausted");
    // A different model only answers to the healthy account-wide windows.
    const other = usageHeadroom(withScoped, NOW, { model: "Sonnet" });
    expect(other.headroom).toBe("ok");
    expect(other.summary).toBe(
      "5h 96% left (resets in 3h 20m) · weekly 90% left (resets in 15h 0m)",
    );
  });

  it("is unknown when the selected model has no applicable windows", () => {
    const scoped = window("weekly", 100, 900, "Weekly · Fable", {
      id: "seven_day_fable",
      appliesToModel: "Fable",
    });
    expect(usageHeadroom(limits(scoped), NOW, { model: "Sonnet" })).toEqual({
      headroom: "unknown",
      summary: "no usage windows apply to Sonnet",
    });
  });

  it("is unknown when the provider reports no windows", () => {
    expect(usageHeadroom(undefined, NOW)).toEqual({
      headroom: "unknown",
      summary: "usage not reported",
    });
  });

  it("requires a current observation even when reset is still in the future", () => {
    expect(usageHeadroom(staleLimits(window("weekly", 10, 900)), NOW).headroom).toBe("unknown");
    expect(
      usageHeadroom({ checkedAt: at(5), windows: [window("weekly", 10, 900)] }, NOW).headroom,
    ).toBe("unknown");
    expect(
      usageHeadroom({ checkedAt: at(-10), windows: [window("weekly", 10, 900)] }, NOW, {
        maxObservationAgeMs: 5 * 60_000,
      }).headroom,
    ).toBe("unknown");
  });

  it("does not assume replenishment when a recent observation predates an elapsed reset", () => {
    expect(
      usageHeadroom({ checkedAt: at(-10), windows: [window("session", 10, -5)] }, NOW),
    ).toEqual({
      headroom: "unknown",
      summary: "usage stale (a window reset since the last check)",
    });
  });

  it("is unknown when the probe failed, never an implicit ok", () => {
    expect(
      usageHeadroom(
        {
          checkedAt: at(0),
          windows: [],
          unavailable: { reason: "probeFailed" },
        },
        NOW,
      ),
    ).toEqual({ headroom: "unknown", summary: "usage not reported" });
  });

  it("trusts a 45-minute-old passive observation while its 5h window has not reset", () => {
    const result = usageHeadroom(
      {
        checkedAt: at(-45),
        windows: [window("session", 40, 240), window("weekly", 10, 900)],
      },
      NOW,
      { trustUnresetWindow: true },
    );
    expect(result.headroom).toBe("ok");
    expect(result.summary).toContain("5h 60% left");
    expect(result.summary).toContain("observed 45m ago");
  });

  it("keeps a stale passive observation admissible after its window reset, from the weekly value", () => {
    const result = usageHeadroom(
      {
        checkedAt: at(-120),
        windows: [window("session", 40, -30), window("weekly", 10, 900)],
      },
      NOW,
      { trustUnresetWindow: true },
    );
    expect(result.headroom).toBe("ok");
    expect(result.summary).toContain("weekly 90% left");
  });

  it("reports unknown when every window reset without a weekly window", () => {
    const result = usageHeadroom(
      {
        checkedAt: at(-400),
        windows: [window("session", 40, -30)],
      },
      NOW,
      { trustUnresetWindow: true },
    );
    expect(result.headroom).toBe("unknown");
    expect(result.summary).toContain("weekly window");
  });

  it("expires the all-reset passive grace one weekly period past the observation", () => {
    const allResetAgo = (checkedAgoMinutes: number) => ({
      checkedAt: at(-checkedAgoMinutes),
      windows: [window("session", 40, -60), window("weekly", 10, -30)],
    });
    const GRACE_MINUTES = 7 * 24 * 60;
    const inside = usageHeadroom(allResetAgo(GRACE_MINUTES), NOW, {
      trustUnresetWindow: true,
    });
    expect(inside.headroom).toBe("ok");
    expect(inside.summary).toContain("likely fresh");
    const outside = usageHeadroom(allResetAgo(GRACE_MINUTES + 1), NOW, {
      trustUnresetWindow: true,
    });
    expect(outside.headroom).toBe("unknown");
  });

  it("reads a multi-week-old healthy passive observation as unknown", () => {
    const result = usageHeadroom(
      {
        checkedAt: at(-21 * 24 * 60),
        windows: [window("session", 40, -30), window("weekly", 10, -60)],
      },
      NOW,
      { trustUnresetWindow: true },
    );
    expect(result.headroom).toBe("unknown");
  });

  it("keeps observed low and exhausted sticky past the passive grace", () => {
    const aged = (usedPercent: number) => ({
      checkedAt: at(-21 * 24 * 60),
      windows: [window("session", usedPercent, -30), window("weekly", 10, -60)],
    });
    expect(usageHeadroom(aged(90), NOW, { trustUnresetWindow: true }).headroom).toBe("low");
    expect(usageHeadroom(aged(100), NOW, { trustUnresetWindow: true }).headroom).toBe("exhausted");
  });

  it("still reports low and exhausted from a stale passive observation", () => {
    const staleLow = {
      checkedAt: at(-45),
      windows: [window("session", 90, 240), window("weekly", 10, 900)],
    };
    expect(usageHeadroom(staleLow, NOW, { trustUnresetWindow: true }).headroom).toBe("low");
    const staleSpent = {
      checkedAt: at(-120),
      windows: [window("session", 100, -30), window("weekly", 10, 900)],
    };
    expect(usageHeadroom(staleSpent, NOW, { trustUnresetWindow: true }).headroom).toBe("exhausted");
  });

  it("stays strict without the passive opt-in", () => {
    expect(
      usageHeadroom(
        {
          checkedAt: at(-45),
          windows: [window("session", 40, 240), window("weekly", 10, 900)],
        },
        NOW,
      ).headroom,
    ).toBe("unknown");
  });
});
