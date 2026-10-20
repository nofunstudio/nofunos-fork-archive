import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadWaitInput,
} from "./orchestratorMcp.ts";

const decodeCapabilitiesResult = Schema.decodeUnknownSync(OrchestratorMcpCapabilitiesResult);
const decodeCreateThreadsInput = Schema.decodeUnknownSync(OrchestratorMcpCreateThreadsInput);
const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);
const decodeThreadInterruptInput = Schema.decodeUnknownSync(OrchestratorMcpThreadInterruptInput);
const decodeThreadListInput = Schema.decodeUnknownSync(OrchestratorMcpThreadListInput);
const decodeThreadReadInput = Schema.decodeUnknownSync(OrchestratorMcpThreadReadInput);
const decodeThreadSendInput = Schema.decodeUnknownSync(OrchestratorMcpThreadSendInput);
const decodeThreadWaitInput = Schema.decodeUnknownSync(OrchestratorMcpThreadWaitInput);

describe("orchestrator MCP contracts", () => {
  it("decodes cross-provider delegated task requests and durable results", () => {
    const request = decodeDelegateTaskInput({
      task: "Inspect the workspace and report the result.",
      target: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      mode: "wait",
      timeoutMs: 5_000,
      clientRequestId: "delegate-1",
      runtimeMode: "inherit",
      interactionMode: "inherit",
    });
    const result = decodeDelegateTaskResult({
      taskId: "node-task-1",
      childThreadId: "thread-child-1",
      childRunId: "run-child-1",
      childNodeId: "node-task-1",
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      summary: "Workspace inspected.",
      resultContextTransferId: "context-transfer-result-1",
      latestTerminalRunId: "run-child-1",
      latestTerminalStatus: "completed",
      latestTerminalSummary: "Workspace inspected.",
      latestTerminalResultContextTransferId: "context-transfer-result-1",
      waitTimedOut: false,
    });

    expect(request.target?.providerInstanceId).toBe("claudeAgent");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Workspace inspected.");
  });

  it("decodes target model options in canonical and shorthand shapes", () => {
    const canonical = decodeDelegateTaskInput({
      task: "Say hello.",
      target: {
        providerInstanceId: "codex",
        model: "gpt-5.6-luna",
        options: [{ id: "reasoning", value: "low" }],
      },
    });
    const shorthand = decodeDelegateTaskInput({
      task: "Say hello.",
      target: {
        providerInstanceId: "codex",
        model: "gpt-5.6-luna",
        options: { reasoning: "low", fastMode: true },
      },
    });

    expect(canonical.target?.options).toEqual([{ id: "reasoning", value: "low" }]);
    expect(shorthand.target?.options).toEqual([
      { id: "reasoning", value: "low" },
      { id: "fastMode", value: true },
    ]);
  });

  it("rejects target model options that are not strings or booleans", () => {
    expect(() =>
      decodeDelegateTaskInput({
        task: "Say hello.",
        target: {
          providerInstanceId: "codex",
          model: "gpt-5.6-luna",
          // Must fail loudly instead of being dropped like legacy persistence.
          options: { reasoning: 3 },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeDelegateTaskInput({
        task: "Say hello.",
        target: {
          providerInstanceId: "codex",
          model: "gpt-5.6-luna",
          options: [{ id: "reasoning", value: null }],
        },
      }),
    ).toThrow();
  });

  describe("requiredContext", () => {
    const hash = "a".repeat(64);
    const inline = {
      path: "skills/example/SKILL.md",
      delivery: "inline",
      step: "step 2: apply the skill",
      length: 12,
      hash,
      revision: "git:5d16d577",
      content: "# Example\nok",
    } as const;
    const request = (requiredContext: unknown) => ({ task: "Do the work.", requiredContext });

    it("is optional and keeps today's input shape when omitted", () => {
      expect(decodeDelegateTaskInput({ task: "Do the work." }).requiredContext).toBeUndefined();
    });

    it("decodes inline and path entries with every identity field", () => {
      const decoded = decodeDelegateTaskInput(
        request([
          inline,
          {
            path: "docs/contract.md",
            delivery: "path",
            step: "step 5",
            length: 1,
            hash,
            revision: "v1",
          },
        ]),
      );

      expect(decoded.requiredContext?.map((entry) => entry.delivery)).toEqual(["inline", "path"]);
      expect(decoded.requiredContext?.[0]).toEqual(inline);
      expect(decoded.requiredContext?.[1]?.content).toBeUndefined();
    });

    it.each([
      ["a short hash", { hash: "abc" }],
      ["an uppercase hash", { hash: "A".repeat(64) }],
      ["a zero length", { length: 0 }],
      ["a fractional length", { length: 1.5 }],
      ["a length over the aggregate bound", { length: 120_001 }],
      ["a revision with whitespace", { revision: "git 5d16d577" }],
      ["an empty revision", { revision: "" }],
      ["an empty step", { step: "  " }],
      ["an unknown delivery", { delivery: "url" }],
      ["a missing hash", { hash: undefined }],
      ["a missing length", { length: undefined }],
      ["a missing revision", { revision: undefined }],
    ])("rejects %s", (_name, override) => {
      expect(() => decodeDelegateTaskInput(request([{ ...inline, ...override }]))).toThrow();
    });

    it("rejects an empty list and more than 64 references", () => {
      expect(() => decodeDelegateTaskInput(request([]))).toThrow();
      const entries = (count: number) =>
        Array.from({ length: count }, (_, index) => ({ ...inline, path: `ref-${index}.md` }));
      expect(decodeDelegateTaskInput(request(entries(64))).requiredContext).toHaveLength(64);
      expect(() => decodeDelegateTaskInput(request(entries(65)))).toThrow();
    });
  });

  it("decodes mixed prompted and empty thread batches", () => {
    const request = decodeCreateThreadsInput({
      clientRequestId: "threads-1",
      threads: [
        { title: "Inherited empty thread" },
        {
          prompt: "Review the API.",
          target: { driverKind: "claudeAgent" },
          runtimeMode: "approval-required",
        },
      ],
    });

    expect(request.threads).toHaveLength(2);
    expect(request.threads[0]?.prompt).toBeUndefined();
    expect(request.threads[1]?.target?.driverKind).toBe("claudeAgent");
  });

  it("decodes project-scoped thread orchestration requests", () => {
    expect(
      decodeThreadListInput({
        statuses: ["running", "completed"],
        includeSubagents: false,
        limit: 25,
      }).statuses,
    ).toEqual(["running", "completed"]);
    expect(
      decodeThreadReadInput({
        threadId: "thread-loop-1",
        view: "activity",
        afterPosition: 10,
      }).afterPosition,
    ).toBe(10);
    expect(
      decodeThreadSendInput({
        threadId: "thread-loop-1",
        message: "Continue with the next iteration.",
        mode: "steer",
        clientRequestId: "send-loop-2",
      }).mode,
    ).toBe("steer");
    expect(
      decodeThreadWaitInput({
        threadId: "thread-loop-1",
        runId: "run-loop-2",
        timeoutMs: 5_000,
      }).runId,
    ).toBe("run-loop-2");
    expect(
      decodeThreadInterruptInput({
        threadId: "thread-loop-1",
        reason: "Loop converged.",
      }).reason,
    ).toBe("Loop converged.");
  });

  it("carries the server build identity in capabilities results", () => {
    const base = {
      parentThreadId: null,
      inheritedProviderInstanceId: null,
      inheritedModel: null,
      runtimeMode: "full-access",
      interactionMode: "default",
      providers: [],
      features: {
        appOwnedSubagents: true,
        asyncPolling: true,
        cancellation: true,
        batchThreadCreation: true,
        threadManagement: true,
        incrementalThreadRead: true,
        scheduledTasks: true,
        maxBatchThreads: 20,
      },
    } as const;
    const withBuild = decodeCapabilitiesResult({
      ...base,
      serverBuild: { sha: "abc123", version: "0.0.45" },
    });
    expect(withBuild.serverBuild).toEqual({ sha: "abc123", version: "0.0.45" });
    // Older servers send no build identity; new clients must still decode.
    const legacy = decodeCapabilitiesResult({ ...base });
    expect(legacy.serverBuild).toBeUndefined();
    const unknown = decodeCapabilitiesResult({
      ...base,
      serverBuild: { sha: null, version: null },
    });
    expect(unknown.serverBuild).toEqual({ sha: null, version: null });
  });
});
