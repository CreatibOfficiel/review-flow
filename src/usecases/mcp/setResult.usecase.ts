import type { JobContextGateway } from "../../entities/job/jobContext.gateway.js";
import type { ReviewContextGateway } from "../../entities/reviewContext/reviewContext.gateway.js";
import {
	reviewContextResultSchema,
	type ReviewContextResult,
} from "../../entities/reviewContext/reviewContextAction.schema.js";

export type SetResultInput = {
	blocking: number;
	warnings: number;
	suggestions: number;
	score: number;
	verdict: "ready_to_merge" | "needs_fixes" | "needs_discussion";
};

export type SetResultResult =
	| { success: true }
	| { success: false; error: string };

export interface SetResultDependencies {
	jobContextGateway: JobContextGateway;
	reviewContextGateway: ReviewContextGateway;
}

export function setResult(
	jobId: string,
	input: SetResultInput,
	deps: SetResultDependencies,
): SetResultResult {
	const { jobContextGateway, reviewContextGateway } = deps;

	const parsed = reviewContextResultSchema.safeParse(input);
	if (!parsed.success) {
		return {
			success: false,
			error: `Invalid result data: ${parsed.error.message}`,
		};
	}

	const jobContext = jobContextGateway.get(jobId);
	if (!jobContext) {
		return {
			success: false,
			error: `Job context not found: ${jobId}`,
		};
	}

	const result = reviewContextGateway.setResult(
		jobContext.localPath,
		jobContext.mergeRequestId,
		parsed.data as ReviewContextResult,
	);

	if (!result.success) {
		return {
			success: false,
			error: "Failed to set result in review context",
		};
	}

	return { success: true };
}
