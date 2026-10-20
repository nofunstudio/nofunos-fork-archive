import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { CommandId } from "../../../../packages/contracts/src/baseSchemas.ts";
import {
  MISSION_SCHEMA_VERSION,
  type Mission,
  type MissionCommand,
  type MissionCreateCommand,
  type MissionEvent,
  type MissionManagers,
  type MissionReplaceCommand,
  type MissionRepositoryBinding,
  type MissionTaskSpec,
} from "../../../../packages/contracts/src/mission.ts";
import { isEmptyMissionExecution } from "../../../../packages/contracts/src/missionExecution.ts";

/**
 * Pure CAS command planner for the mission aggregate. No I/O, no clock reads:
 * the root store supplies `eventId`/`occurredAt`/`sequence`, reads the
 * canonical current aggregate, and commits the returned event. The manager
 * epoch is derived from the current mission, never from caller context.
 * Root dispatch owns admission/attempt receipts; a plan replace cannot
 * synthesize them.
 */

export const MissionPlanErrorCode = Schema.Literals([
  "already_exists",
  "missing_aggregate",
  "invalid_schema_version",
  "invalid_revision",
  "stale_revision",
  "epoch_mismatch",
  "authority_mismatch",
  "empty_binding",
  "invalid_binding",
  "duplicate_binding",
  "immutable_identity",
  "manager_assignment_immutable",
  "missing_manager",
  "duplicate_task_ids",
  "unknown_dependency",
  "invalid_dependency",
  "dependency_cycle",
  "unknown_acceptance",
  "unknown_task_project",
  "forged_admission_ref",
  "forged_execution_state",
]);
export type MissionPlanErrorCode = typeof MissionPlanErrorCode.Type;

export class MissionPlanError extends Schema.TaggedError<MissionPlanError>()("MissionPlanError", {
  code: MissionPlanErrorCode,
  message: Schema.String,
  commandId: Schema.optional(CommandId),
}) {}

/** Context the root store supplies. Deliberately carries no epoch. */
export interface MissionPlanContext {
  readonly sequence: number;
  readonly eventId: MissionEvent["eventId"];
  readonly occurredAt: MissionEvent["occurredAt"];
}

export interface MissionPlanSuccess {
  readonly event: MissionEvent;
  /** Committed next aggregate: invalidated pointers removed, valid refs canonical. */
  readonly mission: Mission;
  readonly invalidatedAdmissionRefs: ReadonlyArray<string>;
  readonly preservedAdmissionRefs: ReadonlyArray<string>;
}

export type MissionPlanResult = Result.Result<MissionPlanSuccess, MissionPlanError>;

const err = (
  commandId: MissionCommand["commandId"],
  code: MissionPlanErrorCode,
  message: string,
): MissionPlanResult => Result.fail(new MissionPlanError({ code, message, commandId }));

const fail = (code: MissionPlanErrorCode, message: string) => ({ code, message });

type Check = { readonly code: MissionPlanErrorCode; readonly message: string } | null;

const eqArr = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const sameAuthority = (
  a: MissionReplaceCommand["authority"],
  b: MissionReplaceCommand["authority"],
): boolean => a.source === b.source && a.ref === b.ref;

const sameBinding = (a: MissionRepositoryBinding, b: MissionRepositoryBinding): boolean =>
  a.projectId === b.projectId &&
  a.workspaceRoot === b.workspaceRoot &&
  a.baseCommit === b.baseCommit &&
  eqArr(a.ancestry, b.ancestry);

const sameBindings = (
  a: ReadonlyArray<MissionRepositoryBinding>,
  b: ReadonlyArray<MissionRepositoryBinding>,
): boolean => a.length === b.length && a.every((binding, i) => sameBinding(binding, b[i]!));

const sameAssignment = (a: MissionManagers["delivery"], b: MissionManagers["delivery"]): boolean =>
  a?.threadId === b?.threadId && a?.epoch === b?.epoch;

const validManagerGrant = (next: MissionManagers, current: MissionManagers): boolean =>
  sameAssignment(next.delivery, current.delivery) &&
  (sameAssignment(next.retro, current.retro) ||
    (current.retro === undefined && next.retro?.threadId !== undefined && next.retro.epoch === 1));

const checkBindings = (bindings: ReadonlyArray<MissionRepositoryBinding>): Check => {
  if (bindings.length === 0) {
    return fail("empty_binding", "Mission must carry at least one repository binding.");
  }
  const projects = new Set<string>();
  const roots = new Set<string>();
  for (const binding of bindings) {
    if (
      binding.projectId.trim().length === 0 ||
      binding.workspaceRoot.trim().length === 0 ||
      binding.baseCommit.trim().length === 0 ||
      binding.ancestry.length === 0
    ) {
      return fail(
        "empty_binding",
        "Mission binding must carry a project, workspace root, base commit, and ancestry.",
      );
    }
    if (!binding.ancestry.includes(binding.baseCommit)) {
      return fail("invalid_binding", "Mission ancestry must include the base commit.");
    }
    if (projects.has(binding.projectId) || roots.has(binding.workspaceRoot)) {
      return fail(
        "duplicate_binding",
        "Mission bindings must have unique project ids and workspace roots.",
      );
    }
    projects.add(binding.projectId);
    roots.add(binding.workspaceRoot);
  }
  return null;
};

const checkTasks = (mission: Mission): Check => {
  const seen = new Set<string>();
  for (const task of mission.tasks) {
    if (seen.has(task.id))
      return fail("duplicate_task_ids", `Duplicate mission task id '${task.id}'.`);
    seen.add(task.id);
  }
  const projects = new Set(mission.bindings.map((b) => b.projectId));
  const criteria = new Set(mission.intent.acceptanceCriteria.map((c) => c.id));
  for (const task of mission.tasks) {
    if (!projects.has(task.projectId)) {
      return fail(
        "unknown_task_project",
        `Task '${task.id}' routes to project '${task.projectId}' with no mission binding.`,
      );
    }
    for (const acceptanceId of task.acceptanceIds) {
      if (!criteria.has(acceptanceId)) {
        return fail(
          "unknown_acceptance",
          `Task '${task.id}' references unknown acceptance criterion '${acceptanceId}'.`,
        );
      }
    }
    if (task.dependencyHashes.length !== task.dependencies.length) {
      return fail(
        "invalid_dependency",
        `Task '${task.id}' must carry one dependency hash per dependency.`,
      );
    }
    if (task.dependencies.includes(task.id)) {
      return fail("dependency_cycle", `Task '${task.id}' depends on itself.`);
    }
    for (const dependency of task.dependencies) {
      if (!seen.has(dependency)) {
        return fail(
          "unknown_dependency",
          `Task '${task.id}' depends on unknown task '${dependency}'.`,
        );
      }
    }
  }
  const indegree = new Map<string, number>();
  const dependents = new Map<string, Array<string>>();
  for (const task of mission.tasks) {
    indegree.set(task.id, task.dependencies.length);
    for (const dependency of task.dependencies) {
      const list = dependents.get(dependency) ?? [];
      list.push(task.id);
      dependents.set(dependency, list);
    }
  }
  const queue: Array<string> = [];
  for (const [id, degree] of indegree) if (degree === 0) queue.push(id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.pop()!;
    visited += 1;
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  if (visited !== mission.tasks.length) {
    return fail("dependency_cycle", "Mission tasks contain a dependency cycle.");
  }
  return null;
};

const taskInputsChanged = (
  current: Mission,
  next: Mission,
  cur: MissionTaskSpec,
  nxt: MissionTaskSpec,
): boolean => {
  if (cur.specHash !== nxt.specHash) return true;
  if (!eqArr(cur.dependencyHashes, nxt.dependencyHashes)) return true;
  if (!eqArr(cur.dependencies, nxt.dependencies)) return true;
  if (!eqArr(cur.acceptanceIds, nxt.acceptanceIds)) return true;
  if (cur.projectId !== nxt.projectId) return true;
  if (cur.writerScope !== nxt.writerScope || cur.taskNecessary !== nxt.taskNecessary) return true;
  for (const field of ["sharedManifestScopes", "guiScopes"] as const) {
    const before = cur[field];
    const after = nxt[field];
    if (before === undefined || after === undefined) {
      if (before !== after) return true;
    } else if (!eqArr(before, after)) return true;
  }
  const beforeText = new Map(current.intent.acceptanceCriteria.map((c) => [c.id, c.text] as const));
  const afterText = new Map(next.intent.acceptanceCriteria.map((c) => [c.id, c.text] as const));
  for (const id of cur.acceptanceIds) {
    if (beforeText.get(id) !== afterText.get(id)) return true;
  }
  return false;
};

const planCreate = (
  command: MissionCreateCommand,
  current: Mission | null,
  ctx: MissionPlanContext,
): MissionPlanResult => {
  if (current !== null) {
    return err(
      command.commandId,
      "already_exists",
      `Mission '${command.mission.id}' already exists.`,
    );
  }
  if (command.mission.schemaVersion !== MISSION_SCHEMA_VERSION) {
    return err(command.commandId, "invalid_schema_version", "Mission schemaVersion must be 1.");
  }
  if (command.mission.revision !== 0) {
    return err(
      command.commandId,
      "invalid_revision",
      "A created mission must start at revision 0.",
    );
  }
  // Execution state is root-owned: a created mission starts empty, and task
  // attempt pointers are only written by the dedicated reservation event.
  if (
    command.mission.execution !== undefined &&
    !isEmptyMissionExecution(command.mission.execution)
  ) {
    return err(
      command.commandId,
      "forged_execution_state",
      "A created mission cannot supply execution admissions, claims, or consumed exceptions.",
    );
  }
  for (const task of command.mission.tasks) {
    if (task.attempt !== undefined) {
      return err(
        command.commandId,
        "forged_admission_ref",
        `Task '${task.id}' carries an admission/attempt not owned by root dispatch.`,
      );
    }
  }
  const bindingCheck = checkBindings(command.mission.bindings);
  if (bindingCheck !== null) return err(command.commandId, bindingCheck.code, bindingCheck.message);
  const taskCheck = checkTasks(command.mission);
  if (taskCheck !== null) return err(command.commandId, taskCheck.code, taskCheck.message);
  return Result.succeed({
    event: {
      sequence: ctx.sequence,
      eventId: ctx.eventId,
      aggregateKind: "mission",
      aggregateId: command.mission.id,
      occurredAt: ctx.occurredAt,
      commandId: command.commandId,
      metadata: {},
      type: "mission.created",
      payload: { mission: command.mission },
    },
    mission: command.mission,
    invalidatedAdmissionRefs: [],
    preservedAdmissionRefs: [],
  });
};

const planReplace = (
  command: MissionReplaceCommand,
  current: Mission | null,
  ctx: MissionPlanContext,
): MissionPlanResult => {
  if (current === null) {
    return err(
      command.commandId,
      "missing_aggregate",
      "Cannot revise a mission that does not exist.",
    );
  }
  if (command.mission.schemaVersion !== MISSION_SCHEMA_VERSION) {
    return err(command.commandId, "invalid_schema_version", "Mission schemaVersion must be 1.");
  }
  if (command.expectedRevision !== current.revision) {
    return err(
      command.commandId,
      "stale_revision",
      `Expected revision ${command.expectedRevision} does not match current revision ${current.revision}.`,
    );
  }
  if (command.mission.revision !== current.revision + 1) {
    return err(
      command.commandId,
      "invalid_revision",
      `Replacement revision must be ${current.revision + 1}.`,
    );
  }
  if (
    command.mission.id !== current.id ||
    command.mission.teamId !== current.teamId ||
    command.mission.authorityEnvironmentId !== current.authorityEnvironmentId
  ) {
    return err(
      command.commandId,
      "immutable_identity",
      "Mission, team, and environment identity are immutable.",
    );
  }
  if (!sameBindings(command.mission.bindings, current.bindings)) {
    return err(
      command.commandId,
      "immutable_identity",
      "Mission repository bindings are immutable.",
    );
  }
  // Root manager epoch comes from the canonical current mission only.
  const manager = current.managers.delivery;
  if (manager?.threadId === undefined || manager.epoch === undefined) {
    return err(
      command.commandId,
      "missing_manager",
      "A managed revision requires a known delivery manager with an epoch on the current mission.",
    );
  }
  if (command.epoch !== manager.epoch) {
    return err(
      command.commandId,
      "epoch_mismatch",
      `Command epoch ${command.epoch} does not match current manager epoch ${manager.epoch}.`,
    );
  }
  if (!current.intent.authorityRefs.some((ref) => sameAuthority(ref, command.authority))) {
    return err(
      command.commandId,
      "authority_mismatch",
      "Command authority is not a recorded mission authority.",
    );
  }
  if (!validManagerGrant(command.mission.managers, current.managers)) {
    return err(
      command.commandId,
      "manager_assignment_immutable",
      "Replacement may grant an unassigned Retro role at epoch 1; existing owners and epochs require a transfer.",
    );
  }
  const taskCheck = checkTasks(command.mission);
  if (taskCheck !== null) return err(command.commandId, taskCheck.code, taskCheck.message);

  const currentById = new Map(current.tasks.map((t) => [t.id, t] as const));
  // Forged admission check: any proposed attempt must be exactly canonical.
  for (const task of command.mission.tasks) {
    if (task.attempt === undefined) continue;
    const cur = currentById.get(task.id);
    if (
      cur?.attempt === undefined ||
      task.attempt.receiptRef !== cur.attempt.receiptRef ||
      task.attempt.attemptNumber !== cur.attempt.attemptNumber
    ) {
      return err(
        command.commandId,
        "forged_admission_ref",
        `Task '${task.id}' carries an admission/attempt not owned by root dispatch.`,
      );
    }
  }

  const nextById = new Map(command.mission.tasks.map((t) => [t.id, t] as const));
  const invalidated: Array<string> = [];
  const preserved: Array<string> = [];
  const invalidatedTaskIds = new Set<string>();
  for (const cur of current.tasks) {
    const ref = cur.attempt?.receiptRef;
    if (ref === undefined) continue;
    const nxt = nextById.get(cur.id);
    const changed = nxt === undefined || taskInputsChanged(current, command.mission, cur, nxt);
    if (changed) {
      invalidated.push(ref);
      invalidatedTaskIds.add(cur.id);
    } else {
      preserved.push(ref);
    }
  }

  const committedTasks: Array<MissionTaskSpec> = command.mission.tasks.map((task) => {
    const cur = currentById.get(task.id);
    const { attempt: _proposed, ...rest } = task;
    if (cur?.attempt !== undefined && !invalidatedTaskIds.has(task.id)) {
      return { ...rest, attempt: cur.attempt };
    }
    return rest;
  });
  // Canonical operational history survives every generic replacement:
  // proposed execution is ignored and the current execution carries forward,
  // even when spec/dependency edits invalidate planning refs. Only the
  // dedicated admission-reserved event appends here.
  const committed: Mission = {
    ...command.mission,
    projectTimezone: command.mission.projectTimezone ?? current.projectTimezone,
    managers: command.mission.managers,
    execution: current.execution,
    tasks: committedTasks,
  };

  return Result.succeed({
    event: {
      sequence: ctx.sequence,
      eventId: ctx.eventId,
      aggregateKind: "mission",
      aggregateId: current.id,
      occurredAt: ctx.occurredAt,
      commandId: command.commandId,
      metadata: {},
      type: "mission.revised",
      payload: {
        mission: committed,
        invalidatedAdmissionRefs: invalidated,
        preservedAdmissionRefs: preserved,
      },
    },
    mission: committed,
    invalidatedAdmissionRefs: invalidated,
    preservedAdmissionRefs: preserved,
  });
};

/**
 * Pure CAS command planner: validates a create/replace command against the
 * current aggregate and returns either the event to persist or a typed plan
 * error. No I/O, no clock reads.
 */
export const planMissionCommand = (
  command: MissionCommand,
  current: Mission | null,
  ctx: MissionPlanContext,
): MissionPlanResult =>
  command.type === "mission.create"
    ? planCreate(command, current, ctx)
    : planReplace(command, current, ctx);
