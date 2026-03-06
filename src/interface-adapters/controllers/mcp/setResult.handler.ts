import type { McpToolResult } from "../../../mcp/types.js";
import {
	setResult,
	type SetResultDependencies,
	type SetResultInput,
} from "../../../usecases/mcp/setResult.usecase.js";

const VALID_VERDICTS = ["ready_to_merge", "needs_fixes", "needs_discussion"] as const;

export function createSetResultHandler(
	deps: SetResultDependencies,
): (args: Record<string, unknown>) => McpToolResult {
	return (args: Record<string, unknown>): McpToolResult => {
		const jobId = args.jobId;
		const blocking = args.blocking;
		const warnings = args.warnings;
		const suggestions = args.suggestions;
		const score = args.score;
		const verdict = args.verdict;
		const findings = Array.isArray(args.findings) ? args.findings as SetResultInput["findings"] : undefined;

		if (typeof jobId !== "string" || !jobId) {
			return {
				content: [{ type: "text", text: "Error: jobId is required" }],
				isError: true,
			};
		}

		if (typeof blocking !== "number" || typeof warnings !== "number" || typeof suggestions !== "number" || typeof score !== "number") {
			return {
				content: [{ type: "text", text: "Error: blocking, warnings, suggestions, and score must be numbers" }],
				isError: true,
			};
		}

		if (typeof verdict !== "string" || !VALID_VERDICTS.includes(verdict as typeof VALID_VERDICTS[number])) {
			return {
				content: [{ type: "text", text: `Error: verdict must be one of: ${VALID_VERDICTS.join(", ")}` }],
				isError: true,
			};
		}

		const result = setResult(jobId, {
			blocking,
			warnings,
			suggestions,
			score,
			verdict: verdict as typeof VALID_VERDICTS[number],
			findings,
		}, deps);

		if (!result.success) {
			return {
				content: [{ type: "text", text: `Error: ${result.error}` }],
				isError: true,
			};
		}

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{
							success: true,
							blocking,
							warnings,
							suggestions,
							score,
							verdict,
						},
						null,
						2,
					),
				},
			],
		};
	};
}
