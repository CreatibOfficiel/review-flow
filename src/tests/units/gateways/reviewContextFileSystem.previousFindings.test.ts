import { describe, it, expect, beforeEach } from "vitest";
import { ReviewContextFileSystemGateway } from "@/interface-adapters/gateways/reviewContext.fileSystem.gateway.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("ReviewContextFileSystemGateway - previousFindings", () => {
  let tempDir: string;
  let gateway: ReviewContextFileSystemGateway;
  const mergeRequestId = "gitlab-project-path-123";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "prevFindings-test-"));
    gateway = new ReviewContextFileSystemGateway();
  });

  it("should store previousFindings when provided in create input", () => {
    const previousFindings = [
      { severity: "warning" as const, description: "Missing timeout", file: "tasks.py", line: 42 },
    ];

    gateway.create({
      localPath: tempDir,
      mergeRequestId,
      platform: "gitlab",
      projectPath: "project/path",
      mergeRequestNumber: 123,
      previousFindings,
    });

    const context = gateway.read(tempDir, mergeRequestId);
    expect(context?.previousFindings).toEqual(previousFindings);
  });

  it("should store previousReport when provided in create input", () => {
    const previousReport = "## Review Report\n\n### Warnings\n1. Missing timeout on task";

    gateway.create({
      localPath: tempDir,
      mergeRequestId,
      platform: "gitlab",
      projectPath: "project/path",
      mergeRequestNumber: 123,
      previousReport,
    });

    const context = gateway.read(tempDir, mergeRequestId);
    expect(context?.previousReport).toBe(previousReport);
  });

  it("should not include previousFindings when not provided", () => {
    gateway.create({
      localPath: tempDir,
      mergeRequestId,
      platform: "gitlab",
      projectPath: "project/path",
      mergeRequestNumber: 123,
    });

    const context = gateway.read(tempDir, mergeRequestId);
    expect(context?.previousFindings).toBeUndefined();
    expect(context?.previousReport).toBeUndefined();
  });
});
