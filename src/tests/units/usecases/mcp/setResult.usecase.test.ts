import { describe, it, expect, beforeEach } from "vitest";
import { JobContextMemoryGateway } from "../../../../interface-adapters/gateways/jobContext.memory.gateway.js";
import { ReviewContextFileSystemGateway } from "../../../../interface-adapters/gateways/reviewContext.fileSystem.gateway.js";
import { setResult } from "../../../../usecases/mcp/setResult.usecase.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("setResult usecase", () => {
  let tempDir: string;
  let jobContextGateway: JobContextMemoryGateway;
  let reviewContextGateway: ReviewContextFileSystemGateway;
  const jobId = "gitlab:project/path:123";
  const mergeRequestId = "gitlab-project-path-123";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "setResult-test-"));
    jobContextGateway = new JobContextMemoryGateway();
    reviewContextGateway = new ReviewContextFileSystemGateway();

    jobContextGateway.register(jobId, { localPath: tempDir, mergeRequestId });
    reviewContextGateway.create({
      localPath: tempDir,
      mergeRequestId,
      platform: "gitlab",
      projectPath: "project/path",
      mergeRequestNumber: 123,
    });
  });

  it("should store findings in review context result", () => {
    const findings = [
      { severity: "warning" as const, description: "Missing timeout on task", file: "tasks.py", line: 42 },
      { severity: "suggestion" as const, description: "Extract shared prompt" },
    ];

    const result = setResult(jobId, {
      blocking: 0,
      warnings: 1,
      suggestions: 1,
      score: 8,
      verdict: "needs_fixes",
      findings,
    }, { jobContextGateway, reviewContextGateway });

    expect(result.success).toBe(true);

    const context = reviewContextGateway.read(tempDir, mergeRequestId);
    expect(context?.result?.findings).toHaveLength(2);
    expect(context?.result?.findings?.[0]).toEqual({
      severity: "warning",
      description: "Missing timeout on task",
      file: "tasks.py",
      line: 42,
    });
    expect(context?.result?.findings?.[1]).toEqual({
      severity: "suggestion",
      description: "Extract shared prompt",
    });
  });

  it("should accept result without findings (backward compat)", () => {
    const result = setResult(jobId, {
      blocking: 0,
      warnings: 0,
      suggestions: 0,
      score: 10,
      verdict: "ready_to_merge",
    }, { jobContextGateway, reviewContextGateway });

    expect(result.success).toBe(true);

    const context = reviewContextGateway.read(tempDir, mergeRequestId);
    expect(context?.result?.findings).toBeUndefined();
  });
});
