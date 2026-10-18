# J01 r2: installed mission creation recovered; admission consumer missing

Status: **PARTIAL / BLOCKED**. Retry started 2026-10-18 21:38 UTC after the owner-initiated restart. J01 performed zero app builds, installs, quits, restarts, or configuration changes. No nofunos main merge/push or CATCHES action.

## Verified on installed F04

Installed ASAR SHA256 remains `4ffcf4c7d9d59d0f7341993b8fc632ce21a2523371be4b09fa51c47e8325dd2a`, CodeResources SHA256 `ec512c4cb85a78347596db1e0d14623edee26cdacb4cccbfdd4410956e584c78`. Both match F04 `4155c53d141d8cd775a72ed6e1765bc7c5b593c5`. Server PID 59384 started `2026-10-18T21:27:35.347Z`. Policy SHA256 is now `f2e616596c55de4aad4944d2e00ac456e892a387524183d24a4be36fa8668e7b`; this project and thread are authorized. The old J01-MISSION-AUTHORITY-POLICY-RESTART blocker is cleared.

| Gate | Observed result |
| --- | --- |
| Canonical mission creation | PASS: exact previously refused `mission.create` accepted; mission `J01-installed-single-host-20261017`, command `J01-installed-single-host-create-v1`, sequence `1788408`. |
| Durable mission receipt | PASS: installed SQL contains one accepted receipt and one `mission.created` event at sequence 1788408. Same-command replay returns `committed=false`, same sequence. This is not a child-result receipt. |
| Actual current role | PASS: fresh `mission_manager_state(delivery)` resolves this thread `mcp:23961559-6c8b-4122-aa45-635a723d1e7a`, epoch 0. Retro read refuses `scope_denied`; no Retro manager is assigned. |
| Lost client ACK / resume | PASS, bounded to mission commands: deliberately withheld the replace response from the client-visible output, recovered the same mission at revision 1, and replayed command `J01-r2-observation-lost-client-ack-v2` with `committed=false`, same sequence 1788541. SQL confirms one `mission.revised` event. No network fault, server restart, child dispatch, or child recovery is claimed. |
| Canonically admitted real child | BLOCKED / UNTESTED: no exposed installed admission consumer found; admission count remains zero. No ordinary delegate substituted. |
| Root integration of child result | UNTESTED: no admitted child result exists. The root's observed-runtime decision at revision 1 is not child integration. |
| Old build refused at mission admission | UNTESTED: no canonical admission route; no old app executed or installed. A matching F04 hash is not old-build refusal. |

The first replace probe used authority not already recorded in the mission and correctly received `plan_rejected/authority_mismatch`: durable rejected command `J01-r2-observation-lost-client-ack-v1`, no event. The corrected v2 command used the existing recorded authority. This caller error and refusal remain in the evidence; they are not a product defect or successful ACK-loss proof.

## New blocker: J01-INSTALLED-CANONICAL-ADMISSION-UNWIRED

Inspection is tied to exact F04 source and the matching installed ASAR. Public tool inventory and `packages/contracts/src/orchestratorMcp.ts:218` expose no mission admission input for `delegate_task`. `apps/server/src/mcp/OrchestratorMcpService.ts:2014` calls `threadManagement.dispatch(command)` without admission options. `ThreadManagementService.ts:559` uses ordinary dispatch when the option is absent; lines 570–571 refuse an internal mission proposal when the mission store/runtime authority is missing. Search of non-test production sources found no composition of `MissionAdmissionStore.layer` / provider for `MissionAdmissionFactsPort`.

The ordinary worker-result bridge is composed, but `MissionWorkerResults.ts:49` requires a committed canonical admission and its paired dispatch receipt before associating a real child result. `MissionCommands.ts:425` preserves canonical execution on generic replacement; replacement cannot manufacture admissions. A mission ID in a prompt or an ordinary child completion would not satisfy this contract.

These are source/API-surface findings, not an observed error from a canonical dispatch endpoint: no such endpoint/tool was available to call. Projects Manager was asked for any existing supported installed route, bridge job `6143002f-0e1e-4dc3-935b-f7848da5d410`; at evidence capture it remained queued. Blocker notice event `evt_6f5270f6d2bcb89256610c56f1d8a360aa71a95962fc5e1047b486ace16e0413`, source `d181-J01-r2-blocker-20261018`.

Do not patch the live process, write SQL admissions, forge receipt refs, or start an ordinary child and label it canonical. If there is no existing supported route, the missing production consumer requires a separately owned source integration/package acceptance task. This retry permits no build or T3 modification.

## J02 handoff

J01's predecessor gate is **not complete**. Unlike r1, a real canonical mission now exists: ID `J01-installed-single-host-20261017`, revision 1, delivery manager this J01 thread, epoch 0. Creation receipt sequence 1788408; revision receipt sequence 1788541. Canonical task `J01-F04-evidence-inventory` has no attempt/admission or child/result pointer; no Retro assignment or manager transfer occurred. J02 must not claim Retro/handoff acceptance against a completed milestone or retire this manager. Preserve this mission and receipts; resolve the admission consumer first, then execute one useful admitted child, review/integrate its result, and exercise dispatch recovery and old-build refusal before J02.

c67d retains P5/backend custody. Reuse its `F04-P4-P5-HANDOFF.md` and `LIVE-ACCEPTANCE-r2.json`; no new Pro Send or P4 receiver repin. The P5 isolated-candidate proof and P4 volatile ACK do not fill this installed execution gap.

Raw local evidence: `/Users/nofun/Documents/Codex/2026-10-17/jobs/J01/r2/` (`installed-initial.json`, `live-command-evidence.json`, `installed-source-wiring.json`, final installed snapshot, process audit). Committed evidence includes sanitized counts/receipts and this handoff. Live SQL reads use URI `mode=ro` and `PRAGMA query_only=ON`; all mission mutations used supported MCP commands.
