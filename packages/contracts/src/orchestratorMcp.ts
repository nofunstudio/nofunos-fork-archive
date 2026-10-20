import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  ContextTransferId,
  IsoDateTime,
  MessageId,
  NodeId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ScheduledTaskId,
  SecretRef,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import {
  ScheduledTaskRunStatus,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { ThreadLinkedPullRequest } from "./threadPullRequest.ts";
import { ThreadTitleRegeneration } from "./threadTitle.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2RunStatus,
  OrchestrationV2TurnItemStatus,
} from "./orchestrationV2.ts";
import {
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ProviderOptionSelectionValue,
} from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

import { ServerProviderUsageWindow } from "./providerUsageLimits.ts";

const OrchestratorMcpPrompt = TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
  description: "Complete task or message text for the target agent.",
});
const OrchestratorMcpTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
  description: "Optional concise display title.",
});
const OrchestratorMcpClientRequestId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
).annotate({ description: "Stable idempotency key to reuse when retrying this mutation." });

/**
 * OpenCode 1.15 has been observed serializing nested MCP union objects as JSON
 * strings. Keep the structured object as the documented form while accepting
 * that compatibility shape at the tool boundary and decoding it immediately.
 */
const OrchestratorMcpScheduleFromJsonString = Schema.fromJsonString(
  ScheduledTaskUpsertSchedule,
).annotate({
  description:
    "Compatibility-only JSON encoding of the schedule object. Prefer a structured object.",
});

const OrchestratorMcpSchedule = Schema.Union([
  ScheduledTaskUpsertSchedule,
  OrchestratorMcpScheduleFromJsonString,
]).annotate({
  description:
    "Trigger object: {type:'interval', everyMs}, {type:'fixed_time', timeOfDay, weekdays?}, or {type:'webhook'} to run on each request to a generated URL. Never stringify it unless the provider requires the compatibility form.",
});

/**
 * Shorthand `{ id: value }` record form for target model options. Unlike the
 * legacy-tolerant `ProviderOptionSelections` persistence schema, this decodes
 * strictly: a value that is not a string or boolean fails the request rather
 * than being silently dropped.
 */
const OrchestratorMcpTargetOptionsFromRecord = Schema.Record(
  Schema.String,
  ProviderOptionSelectionValue,
).pipe(
  Schema.decodeTo(
    Schema.Array(ProviderOptionSelection),
    SchemaTransformation.transformEffect({
      decode: (record) =>
        Effect.succeed(Object.entries(record).map(([id, value]) => ({ id, value }))),
      encode: (selections: ReadonlyArray<ProviderOptionSelection>) =>
        Effect.succeed(
          Object.fromEntries(selections.map((selection) => [selection.id, selection.value])),
        ),
    }),
  ),
);

export const OrchestratorMcpTargetOptions = Schema.Union([
  Schema.Array(ProviderOptionSelection),
  OrchestratorMcpTargetOptionsFromRecord,
]);
export type OrchestratorMcpTargetOptions = typeof OrchestratorMcpTargetOptions.Type;

export const OrchestratorMcpTarget = Schema.Struct({
  providerInstanceId: Schema.optional(
    ProviderInstanceId.annotate({
      description: "Configured provider instance id from orchestrator_capabilities.",
    }),
  ),
  driverKind: Schema.optional(
    ProviderDriverKind.annotate({
      description: "Provider driver kind; prefer providerInstanceId when available.",
    }),
  ),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Model id advertised for the selected provider instance.",
    }),
  ),
  /**
   * Model option selections for the child (for example reasoning effort).
   * Accepts the canonical `[{ id, value }]` array or the shorthand
   * `{ id: value }` record; valid ids come from the option descriptors
   * advertised by orchestrator_capabilities. When omitted, options inherit
   * from the parent only when the child runs the parent's provider and model.
   */
  options: Schema.optional(
    OrchestratorMcpTargetOptions.annotate({
      description: "Model option selections advertised by orchestrator_capabilities.",
    }),
  ),
});
export type OrchestratorMcpTarget = typeof OrchestratorMcpTarget.Type;

export const OrchestratorMcpRuntimeMode = Schema.Union([Schema.Literal("inherit"), RuntimeMode]);
export type OrchestratorMcpRuntimeMode = typeof OrchestratorMcpRuntimeMode.Type;

export const OrchestratorMcpInteractionMode = Schema.Union([
  Schema.Literal("inherit"),
  ProviderInteractionMode,
]);
export type OrchestratorMcpInteractionMode = typeof OrchestratorMcpInteractionMode.Type;

export const OrchestratorMcpTaskRole = Schema.Literals([
  "implementation",
  "research",
  "review",
  "design",
  "test",
  "general",
]);
export type OrchestratorMcpTaskRole = typeof OrchestratorMcpTaskRole.Type;

export const OrchestratorMcpDelegatedTaskStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type OrchestratorMcpDelegatedTaskStatus = typeof OrchestratorMcpDelegatedTaskStatus.Type;

export const OrchestratorMcpTerminalDelegatedTaskStatus = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type OrchestratorMcpTerminalDelegatedTaskStatus =
  typeof OrchestratorMcpTerminalDelegatedTaskStatus.Type;

/** Most references one delegated task can require. */
export const ORCHESTRATOR_MCP_REQUIRED_CONTEXT_MAX_ENTRIES = 64;
/** Most UTF-16 code units of required content one delegated task can carry, summed over its references. */
export const ORCHESTRATOR_MCP_REQUIRED_CONTEXT_MAX_CODE_UNITS = 120_000;

/**
 * One file the child must have in full before it starts, such as a SKILL.md
 * and the references it depends on. The server delivers the exact content in
 * a length-checked fence ahead of the child's first turn or refuses the whole
 * dispatch; it never truncates or edits what it delivers. Delivery proves the
 * child received the bytes, not that it applied them.
 */
export const OrchestratorMcpRequiredContextEntry = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)).annotate({
    description:
      "Identity of the reference, as the child should name it. No whitespace, '|' or '?'. For delivery 'path' it is also the file the server reads, relative to this thread's workspace (symlinks leaving it and credential-shaped names are refused).",
  }),
  delivery: Schema.Literals(["inline", "path"]).annotate({
    description:
      "'inline': you supply the full text in content (preferred). 'path': the server reads path once from this thread's workspace; content must be omitted. Both are checked against length, hash, and revision before anything is created.",
  }),
  step: TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
    description:
      "The task step that needs this reference. No newline or '|'; it is listed in the child's required_references.",
  }),
  length: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: ORCHESTRATOR_MCP_REQUIRED_CONTEXT_MAX_CODE_UNITS }),
  ).annotate({
    description:
      "Exact length of the content in UTF-16 code units (JavaScript String.length), not bytes or characters.",
  }),
  hash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).annotate({
    description: "Lowercase hex SHA-256 of the content encoded as UTF-8.",
  }),
  revision: Schema.String.check(Schema.isPattern(/^\S{1,128}$/)).annotate({
    description:
      "Opaque pointer to the version the content came from (for example a git commit or skill version). Carried verbatim and never interpreted. 1-128 characters, no whitespace.",
  }),
  content: Schema.optional(
    Schema.String.check(Schema.isMaxLength(ORCHESTRATOR_MCP_REQUIRED_CONTEXT_MAX_CODE_UNITS)),
  ).annotate({
    description: "The complete text. Required when delivery is 'inline'; omit it for 'path'.",
  }),
});
export type OrchestratorMcpRequiredContextEntry = typeof OrchestratorMcpRequiredContextEntry.Type;

export const OrchestratorMcpDelegateTaskInput = Schema.Struct({
  mission: Schema.optional(
    Schema.Struct({
      missionId: TrimmedNonEmptyString,
      taskId: TrimmedNonEmptyString,
      attemptKey: Schema.Struct({
        attemptNumber: PositiveInt,
        operation: Schema.Literals(["read", "test", "write"]),
      }),
    }),
  ).annotate({
    description:
      "Canonical mission/task and attempt identity. The server supplies all authority and admission facts. Missing authority denies the call before any child or worktree is created.",
  }),
  task: OrchestratorMcpPrompt.annotate({
    description: "Self-contained task for one delegated child agent/subagent.",
  }),
  /**
   * Skill and reference files the child must receive in full. Omitting it
   * leaves the task text exactly as before. When present, the task text must
   * not carry its own `required_references:` line; the server renders the
   * canonical declaration and the fences from these entries.
   */
  requiredContext: Schema.optional(
    Schema.Array(OrchestratorMcpRequiredContextEntry).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(ORCHESTRATOR_MCP_REQUIRED_CONTEXT_MAX_ENTRIES),
    ),
  ).annotate({
    description: `Up to ${ORCHESTRATOR_MCP_REQUIRED_CONTEXT_MAX_ENTRIES} references totalling at most ${ORCHESTRATOR_MCP_REQUIRED_CONTEXT_MAX_CODE_UNITS} UTF-16 code units. A missing, altered, truncated, or unreadable reference fails the call with 'BLOCKED reference <path>: <reason>' before any child, worktree, or provider is created. Resend it on every delegate_task, follow-up round included.`,
  }),
  target: Schema.optional(OrchestratorMcpTarget),
  title: Schema.optional(OrchestratorMcpTitle),
  workspace: Schema.optional(
    Schema.Struct({
      strategy: Schema.Literals(["inherit", "worktree"]).annotate({
        description:
          "Inherit this thread's workspace (default), or prepare an isolated worktree before the child starts.",
      }),
      branch: Schema.optional(
        TrimmedNonEmptyString.annotate({
          description: "Branch name for a new worktree. Omit it to let T3 choose a stable name.",
        }),
      ),
    }),
  ),
  role: Schema.optional(OrchestratorMcpTaskRole),
  mode: Schema.optional(
    Schema.Literals(["async", "wait"]).annotate({
      description:
        "Defaults to async. Use wait only when this turn needs the child's result before you can continue.",
    }),
  ),
  timeoutMs: Schema.optional(Schema.Number).annotate({
    description:
      "Wait budget for mode=wait only. Default 10 minutes. Elapsing it returns waitTimedOut=true on that call and does not cancel the child.",
  }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  runtimeMode: Schema.optional(OrchestratorMcpRuntimeMode),
  interactionMode: Schema.optional(OrchestratorMcpInteractionMode),
});
export type OrchestratorMcpDelegateTaskInput = typeof OrchestratorMcpDelegateTaskInput.Type;

export const OrchestratorMcpDelegateTaskResult = Schema.Struct({
  /** Resolved launch metadata; null when no independent persisted list exists. */
  requiredContext: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          path: OrchestratorMcpRequiredContextEntry.fields.path,
          sha256: OrchestratorMcpRequiredContextEntry.fields.hash,
        }),
      ).check(Schema.isMaxLength(ORCHESTRATOR_MCP_REQUIRED_CONTEXT_MAX_ENTRIES)),
    ),
  ),
  taskId: NodeId,
  childThreadId: ThreadId,
  childRunId: Schema.NullOr(RunId),
  childNodeId: NodeId,
  status: OrchestratorMcpDelegatedTaskStatus,
  workState: Schema.Literals(["working", "waiting_for_children", "result_available"]),
  hasPendingChildRuns: Schema.Boolean,
  latestTerminalRunId: Schema.NullOr(RunId),
  latestTerminalStatus: Schema.NullOr(OrchestratorMcpTerminalDelegatedTaskStatus),
  latestTerminalSummary: Schema.NullOr(Schema.String),
  latestTerminalResultContextTransferId: Schema.NullOr(ContextTransferId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  resultContextTransferId: Schema.NullOr(ContextTransferId),
  waitTimedOut: Schema.Boolean.annotate({
    description:
      "True only on that mode=wait call when timeoutMs elapsed. The timeout does not cancel the child. Later task_status reads return false and use status for liveness.",
  }),
});
export type OrchestratorMcpDelegateTaskResult = typeof OrchestratorMcpDelegateTaskResult.Type;

export const OrchestratorMcpTaskStatusInput = Schema.Struct({
  taskId: NodeId,
});
export type OrchestratorMcpTaskStatusInput = typeof OrchestratorMcpTaskStatusInput.Type;

export const OrchestratorMcpTaskCancelInput = Schema.Struct({
  taskId: NodeId,
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpTaskCancelInput = typeof OrchestratorMcpTaskCancelInput.Type;

export const OrchestratorMcpTaskCancelResult = Schema.Struct({
  taskId: NodeId,
  status: Schema.Literals(["cancel_requested", "completed", "failed", "cancelled", "interrupted"]),
});
export type OrchestratorMcpTaskCancelResult = typeof OrchestratorMcpTaskCancelResult.Type;

export const OrchestratorMcpCreateThreadRequest = Schema.Struct({
  prompt: Schema.optional(OrchestratorMcpPrompt),
  title: Schema.optional(OrchestratorMcpTitle),
  target: Schema.optional(OrchestratorMcpTarget),
  runtimeMode: Schema.optional(OrchestratorMcpRuntimeMode),
  interactionMode: Schema.optional(OrchestratorMcpInteractionMode),
});
export type OrchestratorMcpCreateThreadRequest = typeof OrchestratorMcpCreateThreadRequest.Type;

export const OrchestratorMcpCreateThreadsInput = Schema.Struct({
  threads: Schema.Array(OrchestratorMcpCreateThreadRequest).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpCreateThreadsInput = typeof OrchestratorMcpCreateThreadsInput.Type;

export const OrchestratorMcpCreatedThreadStatus = Schema.Union([
  Schema.Literal("idle"),
  Schema.Literal("preparing"),
  Schema.Literal("starting"),
  OrchestratorMcpDelegatedTaskStatus,
  Schema.Literal("rolled_back"),
]);
export type OrchestratorMcpCreatedThreadStatus = typeof OrchestratorMcpCreatedThreadStatus.Type;

export const OrchestratorMcpCreatedThread = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: OrchestratorMcpCreatedThreadStatus,
  title: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
});
export type OrchestratorMcpCreatedThread = typeof OrchestratorMcpCreatedThread.Type;

export const OrchestratorMcpCreateThreadsResult = Schema.Struct({
  threads: Schema.Array(OrchestratorMcpCreatedThread),
});
export type OrchestratorMcpCreateThreadsResult = typeof OrchestratorMcpCreateThreadsResult.Type;

export const OrchestratorMcpThreadStatus = Schema.Union([
  Schema.Literal("idle"),
  OrchestrationV2RunStatus,
]);
export type OrchestratorMcpThreadStatus = typeof OrchestratorMcpThreadStatus.Type;

const OrchestratorMcpProjectTarget = Schema.optional(
  ProjectId.annotate({
    description:
      "Project to act on. Omit for the calling thread's project; required when the caller is not a T3 thread.",
  }),
);

export const OrchestratorMcpThreadListInput = Schema.Struct({
  projectId: OrchestratorMcpProjectTarget,
  statuses: Schema.optional(
    Schema.Array(OrchestratorMcpThreadStatus).check(Schema.isMaxLength(10)),
  ),
  titleContains: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  settled: Schema.optional(Schema.Boolean),
  includeSubagents: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type OrchestratorMcpThreadListInput = typeof OrchestratorMcpThreadListInput.Type;

export const OrchestratorMcpThreadListItem = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  status: OrchestratorMcpThreadStatus,
  latestRunId: Schema.NullOr(RunId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  settled: Schema.Boolean,
  settledAt: Schema.NullOr(IsoDateTime),
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
  itemCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadListItem = typeof OrchestratorMcpThreadListItem.Type;

export const OrchestratorMcpThreadListResult = Schema.Struct({
  projectId: ProjectId,
  /** The calling thread, or null when the caller is not a T3 thread. */
  currentThreadId: Schema.NullOr(ThreadId),
  threads: Schema.Array(OrchestratorMcpThreadListItem),
  nextCursor: Schema.NullOr(NonNegativeInt),
  total: NonNegativeInt,
});
export type OrchestratorMcpThreadListResult = typeof OrchestratorMcpThreadListResult.Type;

export const OrchestratorMcpThreadReadInput = Schema.Struct({
  threadId: ThreadId,
  itemId: Schema.optional(TurnItemId),
  textOffset: Schema.optional(NonNegativeInt),
  view: Schema.optional(Schema.Literals(["messages", "activity"])),
  afterPosition: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
  runLimit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(50))),
  maxCharsPerItem: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(50_000))),
});
export type OrchestratorMcpThreadReadInput = typeof OrchestratorMcpThreadReadInput.Type;

export const OrchestratorMcpThreadDetail = Schema.Struct({
  contextUsage: Schema.optional(
    Schema.Struct({
      usedTokens: NonNegativeInt,
      maxTokens: Schema.NullOr(NonNegativeInt),
      updatedAt: IsoDateTime,
    }),
  ),
  lastCompaction: Schema.optional(
    Schema.Struct({
      at: IsoDateTime,
      summaryChars: NonNegativeInt,
    }),
  ),
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  status: OrchestratorMcpThreadStatus,
  latestRunId: Schema.NullOr(RunId),
  activeRunId: Schema.NullOr(RunId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  titleRegeneration: Schema.NullOr(ThreadTitleRegeneration),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
  runCount: NonNegativeInt,
  itemCount: NonNegativeInt,
  pendingRequestCount: NonNegativeInt,
  archived: Schema.Boolean,
  settled: Schema.Boolean,
  settledAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadDetail = typeof OrchestratorMcpThreadDetail.Type;

export const OrchestratorMcpThreadRun = Schema.Struct({
  runId: RunId,
  ordinal: PositiveInt,
  status: OrchestrationV2RunStatus,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestratorMcpThreadRun = typeof OrchestratorMcpThreadRun.Type;

export const OrchestratorMcpThreadTimelineItem = Schema.Struct({
  position: NonNegativeInt,
  visibility: Schema.Literals(["local", "inherited", "synthetic"]),
  sourceThreadId: ThreadId,
  itemId: TurnItemId,
  runId: Schema.NullOr(RunId),
  messageId: Schema.NullOr(MessageId),
  createdBy: Schema.NullOr(OrchestrationV2Actor),
  creationSource: Schema.NullOr(OrchestrationV2CreationSource),
  type: Schema.String,
  status: OrchestrationV2TurnItemStatus,
  title: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  textTruncated: Schema.Boolean,
  nextTextOffset: Schema.optional(Schema.NullOr(NonNegativeInt)),
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadTimelineItem = typeof OrchestratorMcpThreadTimelineItem.Type;

export const OrchestratorMcpThreadReadResult = Schema.Struct({
  thread: OrchestratorMcpThreadDetail,
  recentRuns: Schema.Array(OrchestratorMcpThreadRun),
  items: Schema.Array(OrchestratorMcpThreadTimelineItem),
  nextPosition: Schema.NullOr(NonNegativeInt),
  hasMore: Schema.Boolean,
});
export type OrchestratorMcpThreadReadResult = typeof OrchestratorMcpThreadReadResult.Type;

export const OrchestratorMcpThreadSendInput = Schema.Struct({
  threadId: ThreadId,
  message: OrchestratorMcpPrompt,
  mode: Schema.optional(Schema.Literals(["auto", "queue", "steer", "restart"])),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpThreadSendInput = typeof OrchestratorMcpThreadSendInput.Type;

export const OrchestratorMcpThreadSendResult = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  runId: RunId,
  status: OrchestrationV2RunStatus,
  delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
});
export type OrchestratorMcpThreadSendResult = typeof OrchestratorMcpThreadSendResult.Type;

export const OrchestratorMcpThreadWaitInput = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.optional(RunId),
  timeoutMs: Schema.optional(Schema.Number),
});
export type OrchestratorMcpThreadWaitInput = typeof OrchestratorMcpThreadWaitInput.Type;

export const OrchestratorMcpThreadWaitResult = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: OrchestratorMcpThreadStatus,
  timedOut: Schema.Boolean,
});
export type OrchestratorMcpThreadWaitResult = typeof OrchestratorMcpThreadWaitResult.Type;

export const OrchestratorMcpThreadInterruptInput = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.optional(RunId),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpThreadInterruptInput = typeof OrchestratorMcpThreadInterruptInput.Type;

export const OrchestratorMcpThreadInterruptResult = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: Schema.Union([
    Schema.Literal("interrupt_requested"),
    Schema.Literal("no_active_run"),
    Schema.Literals(["completed", "failed", "cancelled", "interrupted", "rolled_back"]),
  ]),
});
export type OrchestratorMcpThreadInterruptResult = typeof OrchestratorMcpThreadInterruptResult.Type;

/** Successful observation time stays distinct from the passive inventory read. */
const OrchestratorMcpUsageHeadroom = Schema.Struct({
  headroom: Schema.Literals(["ok", "low", "exhausted", "unknown"]),
  summary: Schema.String,
  observedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  ageMs: Schema.optional(Schema.NullOr(Schema.Number)),
  windows: Schema.optional(Schema.Array(ServerProviderUsageWindow)),
  source: Schema.optional(Schema.Literals(["provider", "muse", "unavailable"])),
  readCost: Schema.optional(Schema.Literal("passive")),
});

export const OrchestratorMcpHostCapacity = Schema.Struct({
  delegatedChildren: Schema.optional(
    Schema.Struct({
      active: NonNegativeInt,
      byProviderInstance: Schema.Record(Schema.String, NonNegativeInt),
    }),
  ),
  observedAtMs: Schema.Number,
  hostId: Schema.String,
  bootId: Schema.NullOr(Schema.String),
  cpu: Schema.Struct({
    utilization: Schema.NullOr(Schema.Number),
    count: Schema.Number,
    loadAverage1m: Schema.Number,
    saturated: Schema.NullOr(Schema.Boolean),
  }),
  memory: Schema.Struct({
    totalBytes: Schema.Number,
    availableBytes: Schema.NullOr(Schema.Number),
    pressure: Schema.Literals(["normal", "warning", "critical", "unknown"]),
  }),
  disk: Schema.Struct({
    path: Schema.String,
    availableBytes: Schema.NullOr(Schema.Number),
    floorBytes: Schema.Number,
  }),
  buildLock: Schema.Struct({
    path: Schema.String,
    state: Schema.Literals(["available", "held", "unknown"]),
  }),
  ready: Schema.Boolean,
  reasons: Schema.Array(Schema.String),
});
export type OrchestratorMcpHostCapacity = typeof OrchestratorMcpHostCapacity.Type;

export const OrchestratorMcpProviderCapability = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  displayName: Schema.NullOr(Schema.String),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.NullOr(Schema.String),
      /** Model options a target may select (for example reasoning effort). */
      options: Schema.optional(Schema.Array(ProviderOptionDescriptor)),
      /** Live windows applicable to this model; provider usage stays aggregate. */
      usage: Schema.optional(OrchestratorMcpUsageHeadroom),
    }),
  ),
  canRunChildTask: Schema.Boolean,
  canRunCrossProviderChildTask: Schema.Boolean,
  constraints: Schema.Array(Schema.String),
  /**
   * Live subscription headroom, so routing can spare a nearly spent pool:
   * `low` keeps it for work only it can do, `exhausted` skips it until reset.
   * Optional so clients can decode responses from older servers.
   */
  usage: Schema.optional(OrchestratorMcpUsageHeadroom),
});
export type OrchestratorMcpProviderCapability = typeof OrchestratorMcpProviderCapability.Type;

/**
 * Build identity of the running server executable: the git SHA of the built
 * source plus the version stamped at build time. Null members mean the
 * running server could not determine that value (no build env injected).
 * Admission and the J01 runbook use the SHA as the build identity and the
 * version only as an ordering diagnostic ("older" vs "not equal").
 */
export const OrchestratorMcpServerBuild = Schema.Struct({
  sha: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
});
export type OrchestratorMcpServerBuild = typeof OrchestratorMcpServerBuild.Type;

export const OrchestratorMcpCapabilitiesResult = Schema.Struct({
  /** The calling thread, or null when the caller is not a T3 thread. */
  parentThreadId: Schema.NullOr(ThreadId),
  /** The calling thread's selection, or null when the caller is not a T3 thread. */
  inheritedProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  inheritedModel: Schema.NullOr(Schema.String),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  providers: Schema.Array(OrchestratorMcpProviderCapability),
  hostCapacity: Schema.optional(OrchestratorMcpHostCapacity),
  /**
   * Build identity of the running server executable, so admission (J01 gate
   * 3) can refuse an old build. Optional so clients can still decode
   * capability responses from older servers.
   */
  serverBuild: Schema.optional(OrchestratorMcpServerBuild),
  features: Schema.Struct({
    appOwnedSubagents: Schema.Boolean,
    asyncPolling: Schema.Boolean,
    cancellation: Schema.Boolean,
    batchThreadCreation: Schema.Boolean,
    threadManagement: Schema.Boolean,
    incrementalThreadRead: Schema.Boolean,
    scheduledTasks: Schema.Boolean,
    /** Optional so clients can still decode capability responses from older servers. */
    delegatedTaskWorktrees: Schema.optional(Schema.Boolean),
    maxBatchThreads: Schema.Number,
  }),
});
export type OrchestratorMcpCapabilitiesResult = typeof OrchestratorMcpCapabilitiesResult.Type;

export const OrchestratorMcpScheduleTaskInput = Schema.Struct({
  projectId: OrchestratorMcpProjectTarget,
  prompt: OrchestratorMcpPrompt.annotate({
    description: "Prompt executed on every scheduled run.",
  }),
  schedule: OrchestratorMcpSchedule,
  title: Schema.optional(OrchestratorMcpTitle),
  enabled: Schema.optional(
    Schema.Boolean.annotate({ description: "Whether the schedule starts enabled; defaults true." }),
  ),
  /**
   * When true (the default), the scheduled task fires into the calling thread
   * on each run instead of launching a fresh thread. This is the recurring
   * "wake up in this thread" behaviour reserved for agent-created tasks.
   */
  bindToCurrentThread: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "True (default) posts each run into this thread; false creates a fresh top-level thread per run.",
    }),
  ),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpScheduleTaskInput = typeof OrchestratorMcpScheduleTaskInput.Type;

/** Summary of a scheduled task returned by the schedule/list/update tools. */
export const OrchestratorMcpScheduledTask = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  title: Schema.String,
  prompt: Schema.String,
  enabled: Schema.Boolean,
  projectId: ProjectId,
  boundThreadId: Schema.NullOr(ThreadId),
  schedule: ScheduledTaskSchedule,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  /** For webhook tasks: the public T3 Connect URL. Absent when this environment has no managed tunnel. */
  webhookUrl: Schema.optional(Schema.String).annotate({
    description:
      "Public URL to give the sender. Absent when this environment has no T3 Connect managed tunnel; the user must enable T3 Connect remote access first.",
  }),
  webhookSignature: Schema.optional(Schema.Literals(["none", "set"])).annotate({
    description: "Whether requests must carry a valid signature.",
  }),
});
export type OrchestratorMcpScheduledTask = typeof OrchestratorMcpScheduledTask.Type;

export const OrchestratorMcpScheduleTaskResult = OrchestratorMcpScheduledTask;
export type OrchestratorMcpScheduleTaskResult = typeof OrchestratorMcpScheduleTaskResult.Type;

export const OrchestratorMcpListScheduledTasksInput = Schema.Struct({
  projectId: Schema.optional(
    ProjectId.annotate({
      description:
        "Only list this project's tasks. Omit for the calling thread's project, or for every project when the caller is not a T3 thread.",
    }),
  ),
});
export type OrchestratorMcpListScheduledTasksInput =
  typeof OrchestratorMcpListScheduledTasksInput.Type;

export const OrchestratorMcpListScheduledTasksResult = Schema.Struct({
  tasks: Schema.Array(OrchestratorMcpScheduledTask),
});
export type OrchestratorMcpListScheduledTasksResult =
  typeof OrchestratorMcpListScheduledTasksResult.Type;

export const OrchestratorMcpUpdateScheduledTaskInput = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  prompt: Schema.optional(OrchestratorMcpPrompt),
  title: Schema.optional(OrchestratorMcpTitle),
  schedule: Schema.optional(OrchestratorMcpSchedule),
  enabled: Schema.optional(Schema.Boolean),
  bindToCurrentThread: Schema.optional(Schema.Boolean),
});
export type OrchestratorMcpUpdateScheduledTaskInput =
  typeof OrchestratorMcpUpdateScheduledTaskInput.Type;

export const OrchestratorMcpRequestSecretInput = Schema.Struct({
  label: TrimmedNonEmptyString.annotate({
    description: "What you need, shown as the card's title, e.g. 'GitHub webhook secret'.",
  }),
  reason: TrimmedNonEmptyString.annotate({
    description:
      "One or two sentences on what it is for and where the user gets or also enters it.",
  }),
  placeholder: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "Hint inside the input, e.g. 'Paste your GitHub token'.",
  }),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 60 * 60 * 1_000 })),
  ).annotate({ description: "How long to wait for the user. Default 10 minutes." }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId).annotate({
    description:
      "Reuse when retrying a call that lost its result, so the user sees one card and its answer is returned again. Use a new id to ask again after timed_out or cancelled.",
  }),
});
export type OrchestratorMcpRequestSecretInput = typeof OrchestratorMcpRequestSecretInput.Type;

export const OrchestratorMcpRequestSecretResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("saved").annotate({ description: "secretRef holds the value." }),
    secretRef: SecretRef.annotate({
      description:
        "Pass it to a tool that accepts a secretRef; it works once, and you never see the value.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literals(["declined", "cancelled", "timed_out"]).annotate({
      description:
        "declined: the user chose not to. cancelled: the request ended with the run. timed_out: the user did not answer in time; the card is closed, so ask again with a new clientRequestId if still needed.",
    }),
  }),
]);
export type OrchestratorMcpRequestSecretResult = typeof OrchestratorMcpRequestSecretResult.Type;

export const OrchestratorMcpDeleteScheduledTaskInput = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
});
export type OrchestratorMcpDeleteScheduledTaskInput =
  typeof OrchestratorMcpDeleteScheduledTaskInput.Type;

export const OrchestratorMcpDeleteScheduledTaskResult = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  deleted: Schema.Boolean,
});
export type OrchestratorMcpDeleteScheduledTaskResult =
  typeof OrchestratorMcpDeleteScheduledTaskResult.Type;

export class OrchestratorMcpFailure extends Schema.TaggedError<OrchestratorMcpFailure>()(
  "OrchestratorMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "parent_not_active",
      "provider_unavailable",
      "model_unavailable",
      "runtime_mode_escalation_denied",
      "interaction_mode_escalation_denied",
      "task_not_found",
      "task_not_cancellable",
      "thread_not_found",
      "run_not_found",
      "thread_not_sendable",
      "thread_not_interruptible",
      "invalid_request",
      "orchestration_error",
      "thread_credential_required",
      "target_required",
    ]),
    message: Schema.String,
  },
) {}
