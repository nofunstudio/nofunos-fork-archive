# J01 installed single-host mission delivery/recovery

Gate: **BLOCKED**, not accepted. Evidence captured 2026-10-18 UTC. No source repair was justified: the observed refusal enforces the configured authority boundary.

Installed host: `/Applications/No Fun T3.app`, version `0.0.46-preview.20261017.f044155c53d`, from `job/F04@4155c53d141d8cd775a72ed6e1765bc7c5b593c5`. App ASAR SHA256 `4ffcf4c7d9d59d0f7341993b8fc632ce21a2523371be4b09fa51c47e8325dd2a`, CodeResources SHA256 `ec512c4cb85a78347596db1e0d14623edee26cdacb4cccbfdd4410956e584c78`, and CDHash `ae092f302dbb1bdfba8c5984b9f47fcceffa3782` match F04's package receipt. Runtime PID 1802 started `2026-10-18T00:52:19.333Z`; its open files bind it to this app and the installed `userdata/statev2.sqlite`.

Installed=yes (pre-existing); installed by J01=no; T3 quit/restart/reconfiguration=no; builds=0; children launched=0. Global admission was open (`draining=0`); this does not admit a canonical task. Read-only SQL verified migrations 59–64, including MissionPlanning 63 and MissionPeerHandshake 64. Migrations existing does not prove they first ran under F04.

| Required proof | Observed result |
| --- | --- |
| Useful scoped canonical mission | BLOCKED: actual `mission_execute` create refused with `MissionMcpFailure/scope_denied`. |
| Admitted real child | UNTESTED: no canonical mission or admission exists; no substitute ordinary child launched. |
| Durable mission receipt | ABSENT: zero J01 command receipts/events; zero canonical mission rows. A refusal transcript is not an accepted receipt. |
| Root integration | UNTESTED: no admitted child/result to integrate. This evidence branch is not mission result integration. |
| Lost-ACK/resume preserves identity | UNTESTED on installed host: no accepted command to recover. No restart or speculative duplicate dispatch. |
| Actual current role | Verified NONE: installed canonical mission count=0; delivery `mission_manager_state` refused `MissionLifecycleMcpFailure/scope_denied`. Proposed manager fields confer no role. |
| Old build refused | UNTESTED on installed mission path. F04 identity matched; no old package executed or substituted. Existing P4 replay refusal is not old-build admission refusal. |

## Named blocker

**J01-MISSION-AUTHORITY-POLICY-RESTART**: installed mission policy allows a different project and bootstrap controller. J01's actual project and thread are excluded. Live create/get/current-role requests all refused before durable mission creation. The policy is loaded once at startup (`apps/server/src/mcp/MissionMcpRuntime.ts` in F04, comments at 40–50 and loader at 95–180). Expanding this policy requires reconfiguration and a server restart, both expressly forbidden by Jimmy's current order. No policy edit, direct SQL write, impersonation of the older controller, alternate unauthenticated route, or restart was attempted.

Full local metadata-only evidence: `/Users/nofun/Documents/Codex/2026-10-17/jobs/J01/{runtime-readonly.json,live-mcp-refusals.json,reused-receipts.json,capture-readonly.py,process-audit.log}`. `capture-readonly.py` uses SQLite URI mode=ro plus `PRAGMA query_only=ON`, selects only bounded metadata/counts, and asserts the installed F04 hashes. No credentials or conversation content are captured. No GUI interaction or screenshot acceptance is claimed.

## J02 handoff

J01 has **not** satisfied the predecessor gate. There is no canonical mission ID, admitted child ID, task result, durable receipt, integration revision, delivery epoch, or retro manager to adopt. `J01-installed-single-host-20261017` and `J01-installed-single-host-create-v1` identify only the refused proposed mission/command; never use them as durable success pointers. Do not start dependent Retro/manager-transfer acceptance against a fabricated mission. Preserve the no-T3-changes order. When the owner changes that boundary, explicitly authorize a supported project/bootstrap binding, schedule the startup-loaded policy activation, and run this one canonical mission before J02.

Reuse c67d backend custody; do not repeat Pro Send. Read `/Users/nofun/Documents/Codex/2026-10-17/T3-integrated-L10-Muse-cb00b5e0/F04-P4-P5-HANDOFF.md` and `/Users/nofun/Documents/Codex/2026-10-17/L10-planning-resume/LIVE-ACCEPTANCE-r2.json`. J01 rehashed the actual answer and required attachment against r2: both match. That proof used isolated candidate SQL, reached `proposal_only`, and explicitly excludes installed Scheduler/MCP wake delivery. P4's frozen receiver graph remains unchanged; authenticated handshake/replay refusal has unsupported fencing and volatile ACK. Neither receipt fills J01's installed admission/recovery gap.

No nofunos main merge/push, deployment, package build, or runtime configuration change. Branch-only evidence at `job/J01`; base/main remains `1453e034e891898574f72ecad0bb87836867bee9`.
