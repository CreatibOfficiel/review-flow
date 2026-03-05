import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Logger } from 'pino';
import { verifyGitLabSignature, getGitLabEventType } from '@/security/verifier.js';
import { gitLabMergeRequestEventGuard } from '@/entities/gitlab/gitlabMergeRequestEvent.guard.js';
import { filterGitLabEvent, filterGitLabMrUpdate, filterGitLabMrClose, filterGitLabMrMerge, filterGitLabMrApprove } from '@/interface-adapters/controllers/webhook/eventFilter.js';
import { findRepositoryByProjectPath } from '@/config/loader.js';
import {
  enqueueReview,
  createJobId,
  updateJobProgress,
  cancelJob,
  type ReviewJob,
} from '@/frameworks/queue/pQueueAdapter.js';
import { invokeClaudeReview, sendNotification } from '@/claude/invoker.js';
import type { ReviewRequestTrackingGateway } from '@/interface-adapters/gateways/reviewRequestTracking.gateway.js';
import type { TrackAssignmentUseCase } from '@/usecases/tracking/trackAssignment.usecase.js';
import type { RecordReviewCompletionUseCase } from '@/usecases/tracking/recordReviewCompletion.usecase.js';
import type { RecordPushUseCase } from '@/usecases/tracking/recordPush.usecase.js';
import type { TransitionStateUseCase } from '@/usecases/tracking/transitionState.usecase.js';
import type { CheckFollowupNeededUseCase } from '@/usecases/tracking/checkFollowupNeeded.usecase.js';
import type { SyncThreadsUseCase } from '@/usecases/tracking/syncThreads.usecase.js';
import { loadProjectConfig, getProjectAgents, getFollowupAgents, getFixAgents, getProjectLanguage } from '@/config/projectConfig.js';
import { DEFAULT_AGENTS, DEFAULT_FOLLOWUP_AGENTS, DEFAULT_FIX_AGENTS } from '@/entities/progress/agentDefinition.type.js';
import { parseReviewOutput } from '@/services/statsService.js';
import { parseThreadActions } from '@/services/threadActionsParser.js';
import { executeThreadActions, defaultCommandExecutor } from '@/services/threadActionsExecutor.js';
import { executeActionsFromContext } from '@/services/contextActionsExecutor.js';
import { startWatchingReviewContext, stopWatchingReviewContext } from '@/main/websocket.js';
import type { ReviewContextGateway } from '@/entities/reviewContext/reviewContext.gateway.js';
import type { ThreadFetchGateway } from '@/entities/threadFetch/threadFetch.gateway.js';
import type { DiffMetadataFetchGateway } from '@/entities/diffMetadata/diffMetadata.gateway.js';

export function extractBaseUrl(remoteUrl: string): string | null {
  try {
    // Handle HTTPS URLs: https://gitlab.example.com/group/project.git
    if (remoteUrl.startsWith('http')) {
      const url = new URL(remoteUrl)
      return `${url.protocol}//${url.host}`
    }
    // Handle SSH URLs: git@gitlab.example.com:group/project.git
    const sshMatch = remoteUrl.match(/@([^:]+):/)
    if (sshMatch) {
      return `https://${sshMatch[1]}`
    }
  } catch {
    // Invalid URL — return null
  }
  return null
}

export interface GitLabWebhookDependencies {
  reviewContextGateway: ReviewContextGateway;
  threadFetchGateway: ThreadFetchGateway;
  diffMetadataFetchGateway: DiffMetadataFetchGateway;
  trackAssignment: TrackAssignmentUseCase;
  recordCompletion: RecordReviewCompletionUseCase;
  recordPush: RecordPushUseCase;
  transitionState: TransitionStateUseCase;
  checkFollowupNeeded: CheckFollowupNeededUseCase;
  syncThreads: SyncThreadsUseCase;
}

/**
 * Check if auto-fix should be triggered after a review/followup, and enqueue the fix job if so.
 * Returns true if a fix job was enqueued.
 */
function maybeEnqueueFixJob(
  job: ReviewJob,
  logger: Logger,
  trackingGateway: ReviewRequestTrackingGateway,
  deps: GitLabWebhookDependencies,
): boolean {
  const mrId = `gitlab-${job.projectPath}-${job.mrNumber}`;
  const updatedMr = trackingGateway.getById(job.localPath, mrId);
  if (!updatedMr || updatedMr.state !== 'pending-fix') return false;

  const projectConfig = loadProjectConfig(job.localPath);
  const autoFixEnabled = projectConfig?.autoFix ?? false;
  if (!autoFixEnabled) return false;

  const maxIterations = projectConfig?.maxFixIterations ?? 5;
  if (updatedMr.fixIterations >= maxIterations) {
    logger.info(
      { mrNumber: job.mrNumber, fixIterations: updatedMr.fixIterations, maxIterations },
      'Max fix iterations reached, stopping auto-fix loop'
    );
    sendNotification(
      'Auto-fix arrêté',
      `MR !${job.mrNumber} - Max ${maxIterations} itérations atteint`,
      logger
    );
    return false;
  }

  const skill = projectConfig?.reviewFixSkill || 'review-fix';
  const fixJobId = createJobId('gitlab-fix', job.projectPath, job.mrNumber);
  const fixJob: ReviewJob = {
    id: fixJobId,
    platform: 'gitlab',
    projectPath: job.projectPath,
    localPath: job.localPath,
    mrNumber: job.mrNumber,
    skill,
    mrUrl: job.mrUrl,
    sourceBranch: job.sourceBranch,
    targetBranch: job.targetBranch,
    jobType: 'fix',
    language: getProjectLanguage(job.localPath),
  };

  enqueueReview(fixJob, async (j, signal) => {
    sendNotification('Auto-fix démarré', `MR !${j.mrNumber} - ${j.projectPath} (itération ${updatedMr.fixIterations + 1})`, logger);

    const mergeRequestId = `gitlab-${j.projectPath}-${j.mrNumber}`;
    const contextGateway = deps.reviewContextGateway;
    const threadFetchGw = deps.threadFetchGateway;
    const diffMetadataFetchGw = deps.diffMetadataFetchGateway;

    try {
      const threads = threadFetchGw.fetchThreads(j.projectPath, j.mrNumber);
      let diffMetadata: import('../../../entities/reviewContext/reviewContext.js').DiffMetadata | undefined;
      try {
        diffMetadata = diffMetadataFetchGw.fetchDiffMetadata(j.projectPath, j.mrNumber);
      } catch (error) {
        logger.warn(
          { mrNumber: j.mrNumber, error: error instanceof Error ? error.message : String(error) },
          'Failed to fetch diff metadata for fix, inline comments will be skipped'
        );
      }
      const fixAgentsList = getFixAgents(j.localPath) ?? DEFAULT_FIX_AGENTS;
      contextGateway.create({
        localPath: j.localPath,
        mergeRequestId,
        platform: 'gitlab',
        projectPath: j.projectPath,
        mergeRequestNumber: j.mrNumber,
        threads,
        agents: fixAgentsList,
        diffMetadata,
      });
      logger.info(
        { mrNumber: j.mrNumber, threadsCount: threads.length, hasDiffMetadata: !!diffMetadata },
        'Review context file created with threads for fix'
      );

      startWatchingReviewContext(j.id, j.localPath, mergeRequestId);
    } catch (error) {
      logger.warn(
        { mrNumber: j.mrNumber, error: error instanceof Error ? error.message : String(error) },
        'Failed to create review context file for fix, continuing without it'
      );
    }

    const result = await invokeClaudeReview(j, logger, (progress, progressEvent) => {
      updateJobProgress(j.id, progress, progressEvent);

      const runningAgent = progress.agents.find(a => a.status === 'running');
      const completedAgents = progress.agents
        .filter(a => a.status === 'completed')
        .map(a => a.name);

      contextGateway.updateProgress(j.localPath, mergeRequestId, {
        phase: progress.currentPhase,
        currentStep: runningAgent?.name ?? null,
        stepsCompleted: completedAgents,
      });
    }, signal);

    stopWatchingReviewContext(mergeRequestId);

    if (result.success) {
      // Execute actions from context file (thread replies, resolves, comments)
      let threadResolveCount = 0;
      const reviewContext = contextGateway.read(j.localPath, mergeRequestId);
      if (reviewContext && reviewContext.actions.length > 0) {
        threadResolveCount = reviewContext.actions.filter(a => a.type === 'THREAD_RESOLVE').length;
        const contextActionResult = await executeActionsFromContext(
          reviewContext,
          j.localPath,
          logger,
          defaultCommandExecutor
        );
        logger.info(
          { ...contextActionResult, threadResolveCount, mrNumber: j.mrNumber },
          'Actions executed from context file for fix'
        );
      }

      // Prefer structured result from MCP set_result, fallback to stdout parsing
      const parsed = reviewContext?.result
        ? { score: reviewContext.result.score, blocking: reviewContext.result.blocking, warnings: reviewContext.result.warnings, suggestions: reviewContext.result.suggestions }
        : parseReviewOutput(result.stdout);

      // Record fix completion
      deps.recordCompletion.execute({
        projectPath: j.localPath,
        mrId: mergeRequestId,
        reviewData: {
          type: 'fix',
          durationMs: result.durationMs,
          score: parsed.score,
          blocking: parsed.blocking,
          warnings: parsed.warnings,
          suggestions: parsed.suggestions,
          threadsOpened: 0,
          threadsClosed: threadResolveCount,
        },
      });

      logger.info(
        {
          mrNumber: j.mrNumber,
          durationMs: result.durationMs,
          fixIteration: updatedMr.fixIterations + 1,
        },
        'Fix completed — push will trigger followup automatically'
      );

      sendNotification('Auto-fix terminé', `MR !${j.mrNumber} - ${j.projectPath}`, logger);
    } else if (!result.cancelled) {
      sendNotification('Auto-fix échoué', `MR !${j.mrNumber} - Code ${result.exitCode}`, logger);
      throw new Error(`Fix failed with exit code ${result.exitCode}`);
    }
  });

  logger.info(
    { mrNumber: job.mrNumber, fixIteration: updatedMr.fixIterations + 1, maxIterations },
    'Auto-fix job enqueued'
  );

  return true;
}

export async function handleGitLabWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  logger: Logger,
  trackingGateway: ReviewRequestTrackingGateway,
  deps: GitLabWebhookDependencies
): Promise<void> {
  const { trackAssignment, recordCompletion, recordPush, transitionState, checkFollowupNeeded, syncThreads } = deps;
  // 1. Verify signature
  const verification = verifyGitLabSignature(request);
  if (!verification.valid) {
    logger.warn({ error: verification.error }, 'GitLab signature verification failed');
    reply.status(401).send({ error: verification.error });
    return;
  }

  // 2. Check event type
  const eventType = getGitLabEventType(request);
  if (eventType !== 'Merge Request Hook') {
    logger.debug({ eventType }, 'Ignoring non-MR event');
    reply.status(200).send({ status: 'ignored', reason: 'Not a MR event' });
    return;
  }

  // 3. Parse and validate event
  const parseResult = gitLabMergeRequestEventGuard.safeParse(request.body);
  if (!parseResult.success) {
    logger.warn({ errors: parseResult.error }, 'Invalid GitLab webhook payload');
    reply.status(400).send({ error: 'Invalid webhook payload' });
    return;
  }
  const event = parseResult.data;

  // 3a. Check if MR was closed - clean up tracking and cancel any running job
  const closeResult = filterGitLabMrClose(event);
  if (closeResult.shouldProcess) {
    const projectPath = closeResult.projectPath;
    const mrNumber = closeResult.mergeRequestNumber;
    const mrId = `gitlab-${projectPath}-${mrNumber}`;

    // Find repo config
    const repoConfig = findRepositoryByProjectPath(projectPath);
    if (repoConfig) {
      // Cancel any running job for this MR
      const jobId = createJobId('gitlab', projectPath, mrNumber);
      const cancelled = cancelJob(jobId);

      // Archive the MR from tracking
      const archived = trackingGateway.archive(repoConfig.localPath, mrId);

      // Delete review context file
      const contextGateway = deps.reviewContextGateway;
      const contextDeleted = contextGateway.delete(repoConfig.localPath, mrId);

      logger.info(
        {
          mrNumber,
          project: projectPath,
          jobCancelled: cancelled,
          trackingArchived: archived,
          contextDeleted: contextDeleted.deleted,
        },
        'MR closed - cleaned up tracking and cancelled job'
      );

      reply.status(200).send({
        status: 'cleaned',
        mrNumber,
        jobCancelled: cancelled,
        trackingArchived: archived,
      });
      return;
    }

    // No repo config, just acknowledge
    logger.info({ mrNumber, project: projectPath }, 'MR closed but repo not configured');
    reply.status(200).send({ status: 'ignored', reason: 'MR closed, repo not configured' });
    return;
  }

  // 3b. Check if MR was merged - update tracking state
  const mergeResult = filterGitLabMrMerge(event);
  if (mergeResult.shouldProcess) {
    const repoConfig = findRepositoryByProjectPath(mergeResult.projectPath);
    if (repoConfig) {
      const mrId = `gitlab-${mergeResult.projectPath}-${mergeResult.mergeRequestNumber}`;
      transitionState.execute({ projectPath: repoConfig.localPath, mrId, targetState: 'merged' });
      logger.info({ mrNumber: mergeResult.mergeRequestNumber }, 'MR marked as merged');
      reply.status(200).send({ status: 'merged', mrNumber: mergeResult.mergeRequestNumber });
      return;
    }
  }

  // 3c. Check if MR was approved - update tracking state
  const approveResult = filterGitLabMrApprove(event);
  if (approveResult.shouldProcess) {
    const repoConfig = findRepositoryByProjectPath(approveResult.projectPath);
    if (repoConfig) {
      const mrId = `gitlab-${approveResult.projectPath}-${approveResult.mergeRequestNumber}`;
      transitionState.execute({ projectPath: repoConfig.localPath, mrId, targetState: 'approved' });
      logger.info({ mrNumber: approveResult.mergeRequestNumber }, 'MR marked as approved');
      reply.status(200).send({ status: 'approved', mrNumber: approveResult.mergeRequestNumber });
      return;
    }
  }

  // 3d. Filter for review assignment
  const filterResult = filterGitLabEvent(event);

  // Debug: log reviewers data
  logger.info(
    {
      project: event.project?.path_with_namespace,
      mrIid: event.object_attributes?.iid,
      action: event.object_attributes?.action,
      reviewers: event.reviewers?.map(r => r.username) || 'NONE',
      changesReviewers: event.changes?.reviewers ? 'YES' : 'NO',
      shouldProcess: filterResult.shouldProcess,
      reason: filterResult.reason,
    },
    'GitLab MR event received'
  );

  if (!filterResult.shouldProcess) {
    // Check if this is an MR update that might need a followup review
    const updateResult = filterGitLabMrUpdate(event);
    logger.debug(
      { updateResult, action: event.object_attributes?.action },
      'Checking for followup review'
    );

    if (updateResult.shouldProcess && updateResult.isFollowup) {
      // Find repo config to get local path
      const updateRepoConfig = findRepositoryByProjectPath(updateResult.projectPath);
      if (updateRepoConfig) {
        // Record the push event
        const mr = recordPush.execute({ projectPath: updateRepoConfig.localPath, mrNumber: updateResult.mergeRequestNumber, platform: 'gitlab' });
        logger.info(
          {
            mrNumber: updateResult.mergeRequestNumber,
            mrFound: !!mr,
            mrState: mr?.state,
            lastPushAt: mr?.lastPushAt,
            lastReviewAt: mr?.lastReviewAt,
          },
          'Push event recorded'
        );

        // Check if this MR needs a followup (has open threads and was pushed since last review)
        const needsFollowup = mr && checkFollowupNeeded.execute({ projectPath: updateRepoConfig.localPath, mrNumber: updateResult.mergeRequestNumber, platform: 'gitlab' });
        logger.info({ needsFollowup, mrState: mr?.state }, 'Followup check result');

        if (needsFollowup) {
          if (mr.autoFollowup === false) {
            logger.info(
              { mrNumber: updateResult.mergeRequestNumber, project: updateResult.projectPath },
              'Auto-followup disabled for this MR, skipping'
            );
            reply.status(200).send({ status: 'ignored', reason: 'Auto-followup disabled' });
            return;
          }

          logger.info(
            { mrNumber: updateResult.mergeRequestNumber, project: updateResult.projectPath },
            'Auto-triggering followup review after push'
          );

          const projectConfig = loadProjectConfig(updateRepoConfig.localPath);
          const skill = projectConfig?.reviewFollowupSkill || 'review-followup';

          const followupJobId = createJobId('gitlab-followup', updateResult.projectPath, updateResult.mergeRequestNumber);
          const followupJob: ReviewJob = {
            id: followupJobId,
            platform: 'gitlab',
            projectPath: updateResult.projectPath,
            localPath: updateRepoConfig.localPath,
            mrNumber: updateResult.mergeRequestNumber,
            skill,
            mrUrl: updateResult.mergeRequestUrl,
            sourceBranch: updateResult.sourceBranch,
            targetBranch: updateResult.targetBranch,
            jobType: 'followup',
          };

          enqueueReview(followupJob, async (j, signal) => {
            sendNotification('Review followup démarrée', `MR !${j.mrNumber} - ${j.projectPath}`, logger);

            // Create review context file with pre-fetched threads and diff metadata
            const mergeRequestId = `gitlab-${j.projectPath}-${j.mrNumber}`;
            const contextGateway = deps.reviewContextGateway;
            const threadFetchGw = deps.threadFetchGateway;
            const diffMetadataFetchGw = deps.diffMetadataFetchGateway;

            try {
              const threads = threadFetchGw.fetchThreads(j.projectPath, j.mrNumber);
              let diffMetadata: import('../../../entities/reviewContext/reviewContext.js').DiffMetadata | undefined;
              try {
                diffMetadata = diffMetadataFetchGw.fetchDiffMetadata(j.projectPath, j.mrNumber);
              } catch (error) {
                logger.warn(
                  { mrNumber: j.mrNumber, error: error instanceof Error ? error.message : String(error) },
                  'Failed to fetch diff metadata for followup, inline comments will be skipped'
                );
              }
              const followupAgentsList = getFollowupAgents(j.localPath) ?? DEFAULT_FOLLOWUP_AGENTS;
              contextGateway.create({
                localPath: j.localPath,
                mergeRequestId,
                platform: 'gitlab',
                projectPath: j.projectPath,
                mergeRequestNumber: j.mrNumber,
                threads,
                agents: followupAgentsList,
                diffMetadata,
              });
              logger.info(
                { mrNumber: j.mrNumber, threadsCount: threads.length, hasDiffMetadata: !!diffMetadata },
                'Review context file created with threads for followup'
              );

              startWatchingReviewContext(j.id, j.localPath, mergeRequestId);
              logger.info({ mrNumber: j.mrNumber }, 'Started watching review context for live progress');
            } catch (error) {
              logger.warn(
                { mrNumber: j.mrNumber, error: error instanceof Error ? error.message : String(error) },
                'Failed to create review context file for followup, continuing without it'
              );
            }

            const result = await invokeClaudeReview(j, logger, (progress, progressEvent) => {
              updateJobProgress(j.id, progress, progressEvent);

              // Also update the review context file for file-based progress tracking
              const runningAgent = progress.agents.find(a => a.status === 'running');
              const completedAgents = progress.agents
                .filter(a => a.status === 'completed')
                .map(a => a.name);

              contextGateway.updateProgress(j.localPath, mergeRequestId, {
                phase: progress.currentPhase,
                currentStep: runningAgent?.name ?? null,
                stepsCompleted: completedAgents,
              });
            }, signal);

            stopWatchingReviewContext(mergeRequestId);

            if (result.success) {
              let threadResolveCount = 0;

              // PRIMARY: Execute actions from context file (agent writes actions here)
              const reviewContext = contextGateway.read(j.localPath, mergeRequestId);
              if (reviewContext && reviewContext.actions.length > 0) {
                threadResolveCount = reviewContext.actions.filter(a => a.type === 'THREAD_RESOLVE').length;
                const followupBaseUrl = extractBaseUrl(updateRepoConfig.remoteUrl);
                const contextActionResult = await executeActionsFromContext(
                  reviewContext,
                  j.localPath,
                  logger,
                  defaultCommandExecutor,
                  followupBaseUrl,
                );
                logger.info(
                  { ...contextActionResult, threadResolveCount, mrNumber: j.mrNumber },
                  'Actions executed from context file for followup'
                );
              } else {
                // FALLBACK: Execute thread actions from stdout markers (backward compatibility)
                const threadActions = parseThreadActions(result.stdout);
                if (threadActions.length > 0) {
                  threadResolveCount = threadActions.filter(a => a.type === 'THREAD_RESOLVE').length;
                  const actionResult = await executeThreadActions(
                    threadActions,
                    {
                      platform: 'gitlab',
                      projectPath: j.projectPath,
                      mrNumber: j.mrNumber,
                      localPath: j.localPath,
                    },
                    logger,
                    defaultCommandExecutor
                  );
                  logger.info(
                    { ...actionResult, threadResolveCount, mrNumber: j.mrNumber },
                    'Thread actions executed from stdout markers for followup (fallback)'
                  );
                }
              }

              // Prefer structured result from MCP set_result, fallback to stdout parsing
              const parsed = reviewContext?.result
                ? { score: reviewContext.result.score, blocking: reviewContext.result.blocking, warnings: reviewContext.result.warnings, suggestions: reviewContext.result.suggestions }
                : parseReviewOutput(result.stdout);

              // Sync threads from GitLab FIRST to get real state after followup resolves threads
              const mrId = `gitlab-${j.projectPath}-${j.mrNumber}`;
              const updatedMr = syncThreads.execute({ projectPath: j.localPath, mrId });

              // Record followup completion with parsed stats
              // threadsClosed comes from THREAD_RESOLVE markers parsed from output
              recordCompletion.execute({
                projectPath: j.localPath,
                mrId,
                reviewData: {
                  type: 'followup',
                  durationMs: result.durationMs,
                  score: parsed.score,
                  blocking: parsed.blocking,
                  warnings: parsed.warnings,
                  suggestions: parsed.suggestions,
                  threadsOpened: 0,
                  threadsClosed: threadResolveCount,
                },
              });
              logger.info(
                {
                  mrNumber: j.mrNumber,
                  score: parsed.score,
                  blocking: parsed.blocking,
                  warnings: parsed.warnings,
                  suggestions: parsed.suggestions,
                  durationMs: result.durationMs,
                  openThreads: updatedMr?.openThreads,
                  state: updatedMr?.state,
                },
                'Followup stats recorded and threads synced'
              );

              // Auto-fix: if blocking issues remain after followup and autoFix is enabled
              maybeEnqueueFixJob(j, logger, trackingGateway, deps);

              sendNotification('Review followup terminée', `MR !${j.mrNumber} - ${j.projectPath}`, logger);
            } else if (!result.cancelled) {
              sendNotification('Review followup échouée', `MR !${j.mrNumber} - Code ${result.exitCode}`, logger);
              throw new Error(`Followup review failed with exit code ${result.exitCode}`);
            }
          });

          reply.status(202).send({
            status: 'followup-queued',
            jobId: followupJobId,
            mrNumber: updateResult.mergeRequestNumber,
          });
          return;
        } else if (mr && ['pending-review', 'pending-approval'].includes(mr.state)) {
          // MR is tracked and in an active state but doesn't need a followup
          // (e.g. clean review with no warnings). Trigger a fresh review on new commits.
          logger.info(
            { mrNumber: updateResult.mergeRequestNumber, mrState: mr.state, project: updateResult.projectPath },
            'Triggering fresh review after push on tracked MR'
          );

          const projectConfig = loadProjectConfig(updateRepoConfig.localPath);
          const skill = projectConfig?.reviewSkill || updateRepoConfig.skill;

          const reviewJobId = createJobId('gitlab', updateResult.projectPath, updateResult.mergeRequestNumber);
          const reviewJob: ReviewJob = {
            id: reviewJobId,
            platform: 'gitlab',
            projectPath: updateResult.projectPath,
            localPath: updateRepoConfig.localPath,
            mrNumber: updateResult.mergeRequestNumber,
            skill,
            mrUrl: updateResult.mergeRequestUrl,
            sourceBranch: updateResult.sourceBranch,
            targetBranch: updateResult.targetBranch,
            jobType: 'review',
            language: getProjectLanguage(updateRepoConfig.localPath),
          };

          enqueueReview(reviewJob, async (j, signal) => {
            sendNotification('Review démarrée (push)', `MR !${j.mrNumber} - ${j.projectPath}`, logger);

            const mergeRequestId = `gitlab-${j.projectPath}-${j.mrNumber}`;
            const contextGateway = deps.reviewContextGateway;
            const threadFetchGw = deps.threadFetchGateway;
            const diffMetadataFetchGw = deps.diffMetadataFetchGateway;

            try {
              const threads = threadFetchGw.fetchThreads(j.projectPath, j.mrNumber);
              let diffMetadata: import('../../../entities/reviewContext/reviewContext.js').DiffMetadata | undefined;
              try {
                diffMetadata = diffMetadataFetchGw.fetchDiffMetadata(j.projectPath, j.mrNumber);
              } catch (error) {
                logger.warn(
                  { mrNumber: j.mrNumber, error: error instanceof Error ? error.message : String(error) },
                  'Failed to fetch diff metadata for push review, inline comments will be skipped'
                );
              }
              const reviewAgentsList = getProjectAgents(j.localPath) ?? DEFAULT_AGENTS;
              contextGateway.create({
                localPath: j.localPath,
                mergeRequestId,
                platform: 'gitlab',
                projectPath: j.projectPath,
                mergeRequestNumber: j.mrNumber,
                threads,
                agents: reviewAgentsList,
                diffMetadata,
              });
              logger.info(
                { mrNumber: j.mrNumber, threadsCount: threads.length, hasDiffMetadata: !!diffMetadata },
                'Review context file created with threads for push review'
              );

              startWatchingReviewContext(j.id, j.localPath, mergeRequestId);
            } catch (error) {
              logger.warn(
                { mrNumber: j.mrNumber, error: error instanceof Error ? error.message : String(error) },
                'Failed to create review context file for push review, continuing without it'
              );
            }

            const result = await invokeClaudeReview(j, logger, (progress, progressEvent) => {
              updateJobProgress(j.id, progress, progressEvent);

              const runningAgent = progress.agents.find(a => a.status === 'running');
              const completedAgents = progress.agents
                .filter(a => a.status === 'completed')
                .map(a => a.name);

              contextGateway.updateProgress(j.localPath, mergeRequestId, {
                phase: progress.currentPhase,
                currentStep: runningAgent?.name ?? null,
                stepsCompleted: completedAgents,
              });
            }, signal);

            stopWatchingReviewContext(mergeRequestId);

            if (result.success) {
              const reviewContext = contextGateway.read(j.localPath, mergeRequestId);
              if (reviewContext && reviewContext.actions.length > 0) {
                const contextActionResult = await executeActionsFromContext(
                  reviewContext,
                  j.localPath,
                  logger,
                  defaultCommandExecutor
                );
                logger.info(
                  { ...contextActionResult, mrNumber: j.mrNumber },
                  'Actions executed from context file for push review'
                );
              } else {
                const threadActions = parseThreadActions(result.stdout);
                if (threadActions.length > 0) {
                  const actionResult = await executeThreadActions(
                    threadActions,
                    {
                      platform: 'gitlab',
                      projectPath: j.projectPath,
                      mrNumber: j.mrNumber,
                      localPath: j.localPath,
                    },
                    logger,
                    defaultCommandExecutor
                  );
                  logger.info(
                    { ...actionResult, mrNumber: j.mrNumber },
                    'Thread actions executed from stdout markers for push review (fallback)'
                  );
                }
              }

              // Prefer structured result from MCP set_result, fallback to stdout parsing
              const parsed = reviewContext?.result
                ? { score: reviewContext.result.score, blocking: reviewContext.result.blocking, warnings: reviewContext.result.warnings, suggestions: reviewContext.result.suggestions }
                : parseReviewOutput(result.stdout);

              const mrId = `gitlab-${j.projectPath}-${j.mrNumber}`;
              const updatedMr = syncThreads.execute({ projectPath: j.localPath, mrId });

              recordCompletion.execute({
                projectPath: j.localPath,
                mrId,
                reviewData: {
                  type: 'review',
                  durationMs: result.durationMs,
                  score: parsed.score,
                  blocking: parsed.blocking,
                  warnings: parsed.warnings,
                  suggestions: parsed.suggestions,
                  threadsOpened: parsed.blocking + parsed.warnings,
                  threadsClosed: 0,
                },
              });
              logger.info(
                {
                  mrNumber: j.mrNumber,
                  score: parsed.score,
                  blocking: parsed.blocking,
                  warnings: parsed.warnings,
                  durationMs: result.durationMs,
                  openThreads: updatedMr?.openThreads,
                  state: updatedMr?.state,
                },
                'Push review stats recorded and threads synced'
              );

              maybeEnqueueFixJob(j, logger, trackingGateway, deps);

              sendNotification('Review terminée (push)', `MR !${j.mrNumber} - ${j.projectPath}`, logger);
            } else if (!result.cancelled) {
              sendNotification('Review échouée (push)', `MR !${j.mrNumber} - Code ${result.exitCode}`, logger);
              throw new Error(`Push review failed with exit code ${result.exitCode}`);
            }
          });

          reply.status(202).send({
            status: 'review-queued',
            jobId: reviewJobId,
            mrNumber: updateResult.mergeRequestNumber,
          });
          return;
        }
      }
    }

    reply.status(200).send({ status: 'ignored', reason: filterResult.reason });
    return;
  }

  // 4. Find repository configuration
  const repoConfig = findRepositoryByProjectPath(filterResult.projectPath);
  if (!repoConfig) {
    logger.warn(
      { projectPath: filterResult.projectPath },
      'Projet non configuré'
    );
    reply.status(200).send({
      status: 'ignored',
      reason: 'Repository not configured',
    });
    return;
  }

  // 5. Track MR assignment with user info
  // Use MR assignee (actual owner), not webhook trigger (who added the reviewer)
  const mrTitle = event.object_attributes?.title || `MR !${filterResult.mergeRequestNumber}`;
  const mrAssignee = event.assignees?.[0];
  const assignedBy = {
    username: mrAssignee?.username || event.user?.username || 'unknown',
    displayName: mrAssignee?.name || event.user?.name,
  };

  trackAssignment.execute({
    projectPath: repoConfig.localPath,
    mrInfo: {
      mrNumber: filterResult.mergeRequestNumber,
      title: mrTitle,
      url: filterResult.mergeRequestUrl,
      project: filterResult.projectPath,
      platform: 'gitlab',
      sourceBranch: filterResult.sourceBranch,
      targetBranch: filterResult.targetBranch,
    },
    assignedBy,
  });

  logger.info(
    { mrNumber: filterResult.mergeRequestNumber, assignedBy: assignedBy.username },
    'MR tracked for review'
  );

  // 5b. Fix-first: if open threads exist from a previous review, fix them before reviewing
  const threadFetchGwAssignment = deps.threadFetchGateway;
  let existingThreads: import('../../../entities/reviewContext/reviewContext.js').ReviewContextThread[] = [];
  try {
    existingThreads = threadFetchGwAssignment.fetchThreads(filterResult.projectPath, filterResult.mergeRequestNumber);
  } catch (error) {
    logger.warn(
      { mrNumber: filterResult.mergeRequestNumber, error: error instanceof Error ? error.message : String(error) },
      'Failed to fetch existing threads for fix-first check, proceeding with normal review'
    );
  }
  const openThreads = existingThreads.filter(t => t.status === 'open');

  if (openThreads.length > 0) {
    const projectConfigForFix = loadProjectConfig(repoConfig.localPath);
    const autoFixEnabled = projectConfigForFix?.autoFix ?? false;

    if (autoFixEnabled) {
      logger.info(
        { mrNumber: filterResult.mergeRequestNumber, openThreads: openThreads.length },
        'Open threads found on assignment, running fix-first before review'
      );

      // Set state to pending-fix so maybeEnqueueFixJob recognizes it
      const mrId = `gitlab-${filterResult.projectPath}-${filterResult.mergeRequestNumber}`;
      trackingGateway.update(repoConfig.localPath, mrId, {
        state: 'pending-fix',
        openThreads: openThreads.length,
      });

      const fixFirstJob: ReviewJob = {
        id: createJobId('gitlab', filterResult.projectPath, filterResult.mergeRequestNumber),
        platform: 'gitlab',
        projectPath: filterResult.projectPath,
        localPath: repoConfig.localPath,
        mrNumber: filterResult.mergeRequestNumber,
        skill: repoConfig.skill,
        mrUrl: filterResult.mergeRequestUrl,
        sourceBranch: filterResult.sourceBranch,
        targetBranch: filterResult.targetBranch,
        jobType: 'review',
        language: getProjectLanguage(repoConfig.localPath),
      };

      const fixEnqueued = maybeEnqueueFixJob(fixFirstJob, logger, trackingGateway, deps);

      if (fixEnqueued) {
        reply.status(202).send({
          status: 'fix-first',
          message: `${openThreads.length} open threads found, fixing before review`,
        });
        return;
      }
      // If fix not enqueued (max iterations, autoFix disabled at project level, etc.), fall through to normal review
    }
  }

  // 6. Create and enqueue job
  const jobId = createJobId('gitlab', filterResult.projectPath, filterResult.mergeRequestNumber);
  const job: ReviewJob = {
    id: jobId,
    platform: 'gitlab',
    projectPath: filterResult.projectPath,
    localPath: repoConfig.localPath,
    mrNumber: filterResult.mergeRequestNumber,
    skill: repoConfig.skill,
    mrUrl: filterResult.mergeRequestUrl,
    sourceBranch: filterResult.sourceBranch,
    targetBranch: filterResult.targetBranch,
    jobType: 'review',
    language: getProjectLanguage(repoConfig.localPath),
    // MR metadata for dashboard
    title: mrTitle,
    description: event.object_attributes?.description,
    assignedBy,
  };

  const enqueued = await enqueueReview(job, async (j, signal) => {
    // Send start notification
    sendNotification(
      'Review démarrée',
      `MR !${j.mrNumber} - ${j.projectPath}`,
      logger
    );

    // Create review context file with pre-fetched threads and diff metadata
    const mergeRequestId = `gitlab-${j.projectPath}-${j.mrNumber}`;
    const contextGateway = deps.reviewContextGateway;
    const threadFetchGw = deps.threadFetchGateway;
    const diffMetadataFetchGw = deps.diffMetadataFetchGateway;

    try {
      const threads = threadFetchGw.fetchThreads(j.projectPath, j.mrNumber);
      let diffMetadata: import('../../../entities/reviewContext/reviewContext.js').DiffMetadata | undefined;
      try {
        diffMetadata = diffMetadataFetchGw.fetchDiffMetadata(j.projectPath, j.mrNumber);
      } catch (error) {
        logger.warn(
          { mrNumber: j.mrNumber, error: error instanceof Error ? error.message : String(error) },
          'Failed to fetch diff metadata, inline comments will be skipped'
        );
      }
      const reviewAgentsList = getProjectAgents(j.localPath) ?? DEFAULT_AGENTS;
      contextGateway.create({
        localPath: j.localPath,
        mergeRequestId,
        platform: 'gitlab',
        projectPath: j.projectPath,
        mergeRequestNumber: j.mrNumber,
        threads,
        agents: reviewAgentsList,
        diffMetadata,
      });
      logger.info(
        { mrNumber: j.mrNumber, threadsCount: threads.length, hasDiffMetadata: !!diffMetadata },
        'Review context file created with threads'
      );

      startWatchingReviewContext(j.id, j.localPath, mergeRequestId);
      logger.info({ mrNumber: j.mrNumber }, 'Started watching review context for live progress');
    } catch (error) {
      logger.warn(
        { mrNumber: j.mrNumber, error: error instanceof Error ? error.message : String(error) },
        'Failed to create review context file, continuing without it'
      );
    }

    // Invoke Claude with progress tracking and cancellation support
    const result = await invokeClaudeReview(j, logger, (progress, progressEvent) => {
      updateJobProgress(j.id, progress, progressEvent);

      // Also update the review context file for file-based progress tracking
      const runningAgent = progress.agents.find(a => a.status === 'running');
      const completedAgents = progress.agents
        .filter(a => a.status === 'completed')
        .map(a => a.name);

      contextGateway.updateProgress(j.localPath, mergeRequestId, {
        phase: progress.currentPhase,
        currentStep: runningAgent?.name ?? null,
        stepsCompleted: completedAgents,
      });
    }, signal);

    // Stop watching context file (auto-stops on completion, but explicit stop for error cases)
    stopWatchingReviewContext(mergeRequestId);

    // Send completion notification and record stats
    if (result.cancelled) {
      sendNotification(
        'Review annulée',
        `MR !${j.mrNumber} - ${j.projectPath}`,
        logger
      );
    } else if (result.success) {
      // PRIMARY: Execute actions from context file (agent writes actions here)
      const reviewContext = contextGateway.read(j.localPath, mergeRequestId);
      if (reviewContext && reviewContext.actions.length > 0) {
        const reviewBaseUrl = extractBaseUrl(repoConfig.remoteUrl);
        const contextActionResult = await executeActionsFromContext(
          reviewContext,
          j.localPath,
          logger,
          defaultCommandExecutor,
          reviewBaseUrl,
        );
        logger.info(
          { ...contextActionResult, mrNumber: j.mrNumber },
          'Actions executed from context file'
        );
      } else {
        // FALLBACK: Execute thread actions from stdout markers (backward compatibility)
        const threadActions = parseThreadActions(result.stdout);
        if (threadActions.length > 0) {
          const actionResult = await executeThreadActions(
            threadActions,
            {
              platform: 'gitlab',
              projectPath: j.projectPath,
              mrNumber: j.mrNumber,
              localPath: j.localPath,
            },
            logger,
            defaultCommandExecutor
          );
          logger.info(
            { ...actionResult, mrNumber: j.mrNumber },
            'Thread actions executed from stdout markers (fallback)'
          );
        }
      }

      // Prefer structured result from MCP set_result, fallback to stdout parsing
      const parsed = reviewContext?.result
        ? { score: reviewContext.result.score, blocking: reviewContext.result.blocking, warnings: reviewContext.result.warnings, suggestions: reviewContext.result.suggestions }
        : parseReviewOutput(result.stdout);

      // Record review completion with parsed stats
      // Only blocking issues count as open threads - warnings are informational
      recordCompletion.execute({
        projectPath: j.localPath,
        mrId: `gitlab-${j.projectPath}-${j.mrNumber}`,
        reviewData: {
          type: 'review',
          durationMs: result.durationMs,
          score: parsed.score,
          blocking: parsed.blocking,
          warnings: parsed.warnings,
          suggestions: parsed.suggestions,
          threadsOpened: parsed.blocking, // Only blocking issues open threads
        },
      });

      logger.info(
        {
          mrNumber: j.mrNumber,
          score: parsed.score,
          blocking: parsed.blocking,
          warnings: parsed.warnings,
          suggestions: parsed.suggestions,
          durationMs: result.durationMs,
        },
        'Review stats recorded'
      );

      // Auto-fix: if blocking issues found and autoFix is enabled, enqueue fix job
      maybeEnqueueFixJob(j, logger, trackingGateway, deps);

      sendNotification(
        'Review terminée',
        `MR !${j.mrNumber} - ${j.projectPath}`,
        logger
      );
    } else {
      sendNotification(
        'Review échouée',
        `MR !${j.mrNumber} - Code ${result.exitCode}`,
        logger
      );
      // Throw to mark job as failed (allows retry)
      throw new Error(`Review failed with exit code ${result.exitCode}`);
    }
  });

  if (enqueued) {
    reply.status(202).send({
      status: 'queued',
      jobId,
      mrNumber: filterResult.mergeRequestNumber,
    });
  } else {
    reply.status(200).send({
      status: 'deduplicated',
      jobId,
      reason: 'Review already in progress or recently completed',
    });
  }
}
