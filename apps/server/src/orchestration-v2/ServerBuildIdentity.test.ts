import { assert, describe, it } from "@effect/vitest";

import {
  assessBuildCurrency,
  compareBuildVersions,
  isSameBuild,
  readServerBuild,
  type ServerBuild,
} from "./ServerBuildIdentity.ts";

const SHA_A = "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d0000000000000000000000000";
const SHA_B = "b2ee2aab36da0982634aa5781b9a66dd18a0bc5e1111111111111111111111111";

describe("readServerBuild", () => {
  it("resolves sha and version from the build environment", () => {
    assert.deepEqual(
      readServerBuild({
        NOFUN_SERVER_BUILD_SHA: SHA_A,
        NOFUN_SERVER_BUILD_VERSION: "0.0.45",
      }),
      { sha: SHA_A, version: "0.0.45" },
    );
  });

  it("treats missing or blank values as unknown", () => {
    assert.deepEqual(readServerBuild({}), { sha: null, version: null });
    assert.deepEqual(
      readServerBuild({ NOFUN_SERVER_BUILD_SHA: "   ", NOFUN_SERVER_BUILD_VERSION: "" }),
      { sha: null, version: null },
    );
  });

  it("trims surrounding whitespace", () => {
    assert.deepEqual(
      readServerBuild({
        NOFUN_SERVER_BUILD_SHA: `  ${SHA_A}\n`,
        NOFUN_SERVER_BUILD_VERSION: "  0.0.45  ",
      }),
      { sha: SHA_A, version: "0.0.45" },
    );
  });
});

describe("isSameBuild", () => {
  it("matches only on equal non-null shas", () => {
    const running: ServerBuild = { sha: SHA_A, version: "0.0.45" };
    assert.isTrue(isSameBuild(running, { sha: SHA_A, version: "0.0.44" }));
    assert.isFalse(isSameBuild(running, { sha: SHA_B, version: "0.0.45" }));
    assert.isFalse(isSameBuild({ sha: null, version: "0.0.45" }, { sha: SHA_A, version: null }));
  });
});

describe("compareBuildVersions", () => {
  it("orders numeric dot-separated versions", () => {
    assert.equal(compareBuildVersions("0.0.44", "0.0.45"), -1);
    assert.equal(compareBuildVersions("0.0.45", "0.0.45"), 0);
    assert.equal(compareBuildVersions("0.0.45", "0.0.44"), 1);
    assert.equal(compareBuildVersions("0.0.45", "0.0.45.1"), -1);
  });

  it("returns null when either side is missing or not numeric", () => {
    assert.isNull(compareBuildVersions(null, "0.0.45"));
    assert.isNull(compareBuildVersions("0.0.45", null));
    assert.isNull(compareBuildVersions("dev", "0.0.45"));
    assert.isNull(compareBuildVersions("abc", "abc"));
  });
});

describe("assessBuildCurrency", () => {
  it("passes when the mission pins no build", () => {
    assert.deepEqual(assessBuildCurrency({ sha: null, version: null }, null), { ok: true });
  });

  it("passes when the running sha equals the required sha", () => {
    assert.deepEqual(
      assessBuildCurrency({ sha: SHA_A, version: "0.0.44" }, { sha: SHA_A, version: "0.0.45" }),
      { ok: true },
    );
  });

  it("refuses an unknown running build when a build is required", () => {
    assert.deepEqual(
      assessBuildCurrency({ sha: null, version: null }, { sha: SHA_A, version: "0.0.45" }),
      { ok: false, reason: "unknown-running" },
    );
  });

  it("reports older when the running version orders below the required version", () => {
    assert.deepEqual(
      assessBuildCurrency({ sha: SHA_B, version: "0.0.44" }, { sha: SHA_A, version: "0.0.45" }),
      { ok: false, reason: "older" },
    );
  });

  it("reports not-equal when shas differ without version ordering", () => {
    assert.deepEqual(
      assessBuildCurrency({ sha: SHA_B, version: null }, { sha: SHA_A, version: null }),
      { ok: false, reason: "not-equal" },
    );
    assert.deepEqual(
      assessBuildCurrency({ sha: SHA_B, version: "0.0.46" }, { sha: SHA_A, version: "0.0.45" }),
      { ok: false, reason: "not-equal" },
    );
  });
});
