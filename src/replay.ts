import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext, Page } from 'playwright';

import { verifyArtifactChecksum } from './core/checksum.js';
import { EvidenceWriter } from './core/evidence.js';
import { sanitizeObject } from './core/redaction.js';
import {
  capabilityArtifactSchema,
  replayResultSchema,
  type CapabilityArtifact,
  type LLMAction,
  type PolicyConfig,
} from './core/schemas.js';
import { substituteTemplate } from './core/template.js';
import { evaluatePolicy } from './core/policy.js';
import type { HandoffManager } from './runtime/handoff.js';
import { PlaywrightSurfaceAdapter } from './surface/playwright.js';

const validateInputs = (
  artifact: CapabilityArtifact,
  inputs: Record<string, string>
): void => {
  for (const parameter of artifact.inputParameters) {
    const value = inputs[parameter.name];
    if (parameter.required && !value) {
      throw new Error(`Missing required input ${parameter.name}`);
    }
    if (
      parameter.pattern &&
      value &&
      !new RegExp(parameter.pattern).test(value)
    ) {
      throw new Error(`Input ${parameter.name} failed pattern validation`);
    }
  }
};

const hydrateAction = (
  action: LLMAction,
  inputs: Record<string, string>,
  options?: { overrideNavigateUrl?: string }
): LLMAction => {
  const hydrated = structuredClone(action);
  if ('value' in hydrated) {
    hydrated.value = substituteTemplate(hydrated.value, inputs);
  }
  if ('url' in hydrated && hydrated.url) {
    hydrated.url =
      options?.overrideNavigateUrl ?? substituteTemplate(hydrated.url, inputs);
  }
  if ('route' in hydrated && hydrated.route) {
    hydrated.route = substituteTemplate(hydrated.route, inputs);
  }
  if ('expected' in hydrated) {
    hydrated.expected = substituteTemplate(hydrated.expected, inputs);
  }
  return hydrated;
};

const failureResult = (
  correlationId: string,
  overrides: Omit<
    Extract<ReturnType<typeof replayResultSchema.parse>, { status: 'failure' }>,
    'status' | 'correlationId' | 'evidencePaths'
  >,
  evidencePaths: string[]
) =>
  replayResultSchema.parse({
    status: 'failure',
    correlationId,
    evidencePaths,
    ...overrides,
  });

const ensureWithinRunBudget = (
  startedAt: number,
  maxRunDurationMs: number,
  phase: string
): void => {
  if (Date.now() - startedAt > maxRunDurationMs) {
    throw new Error(`Run exceeded max duration during ${phase}`);
  }
};

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
    ),
  ]);

const detectObservationResult = (
  correlationId: string,
  observation: { visibleText: string; url: string },
  stepId: string,
  expectedState: string,
  evidencePaths: string[]
): ReturnType<typeof replayResultSchema.parse> | undefined => {
  if (observation.visibleText.includes('No synthetic member matched')) {
    return replayResultSchema.parse({
      status: 'business_outcome',
      code: 'MEMBER_NOT_FOUND',
      message: 'Member was not found in synthetic application.',
      correlationId,
    });
  }
  const failureMatrix = [
    [
      'Validation error',
      'VALIDATION_ERROR',
      'Synthetic target application reported a validation error.',
      'hard-failure',
    ],
    [
      'Permission denied',
      'PERMISSION_DENIED',
      'Synthetic target application denied access.',
      'hard-failure',
    ],
    [
      'Session expired',
      'SESSION_EXPIRED',
      'Synthetic target application expired the session.',
      'recoverable',
    ],
    [
      'Synthetic application error',
      'APPLICATION_ERROR',
      'Synthetic target application returned an application error.',
      'hard-failure',
    ],
  ] as const;
  for (const [needle, code, message, recoverability] of failureMatrix) {
    if (observation.visibleText.includes(needle)) {
      return failureResult(
        correlationId,
        {
          category:
            needle === 'Permission denied'
              ? 'Permission denial'
              : needle === 'Session expired'
                ? 'Session expiration'
                : needle === 'Synthetic application error'
                  ? 'Application error'
                  : 'Validation error',
          code,
          message,
          stepId,
          expectedState,
          observedState: observation.visibleText.slice(0, 160),
          recoverability,
        },
        evidencePaths
      );
    }
  }
  return undefined;
};

export const runReplay = async (params: {
  artifactPath: string;
  targetUrl?: string;
  inputs: Record<string, string>;
  policy: PolicyConfig;
  evidenceBaseDir: string;
  headed?: boolean;
  handoffManager?: HandoffManager;
  onInterventionRequested?: (context: {
    interventionId: string;
    context: BrowserContext;
    page: Page;
  }) => Promise<void>;
}): Promise<ReturnType<typeof replayResultSchema.parse>> => {
  const artifact = capabilityArtifactSchema.parse(
    JSON.parse(await readFile(params.artifactPath, 'utf8'))
  );
  if (!verifyArtifactChecksum(artifact)) {
    throw new Error('Artifact checksum verification failed');
  }
  validateInputs(artifact, params.inputs);

  const evidence = new EvidenceWriter(params.evidenceBaseDir);
  await evidence.init({ artifactPath: params.artifactPath, mode: 'replay' });

  const adapter = await PlaywrightSurfaceAdapter.launch({
    targetUrl: params.targetUrl ?? artifact.defaults.baseUrl,
    headed: params.headed,
  });
  const targets = new Map(
    artifact.targets.map((target) => [target.id, target])
  );
  const outputs: Record<string, string> = {};
  const startedAt = Date.now();

  try {
    for (const step of artifact.steps) {
      ensureWithinRunBudget(
        startedAt,
        params.policy.maxRunDurationMs,
        `${step.id} start`
      );
      const action = hydrateAction(step.action, params.inputs, {
        overrideNavigateUrl:
          params.targetUrl && step.action.type === 'navigate'
            ? params.targetUrl
            : undefined,
      });
      const target =
        'targetId' in action && action.targetId
          ? targets.get(action.targetId)
          : undefined;
      const observationBefore = await withTimeout(
        adapter.observe(
          join(evidence.runDir, 'screenshots'),
          `${step.id}-before`
        ),
        step.timeoutMs,
        `${step.id} observation`
      );
      await evidence.appendEvent({
        stepId: step.id,
        phase: 'before',
        observation: sanitizeObject(observationBefore),
        action,
      });
      const preExecutionResult = detectObservationResult(
        evidence.correlationId,
        observationBefore,
        step.id,
        JSON.stringify(step.expectedPageState),
        await evidence.listFiles()
      );
      if (preExecutionResult) {
        await evidence.writeJson('result.json', preExecutionResult);
        await evidence.writeManifest('replay', 'none');
        return preExecutionResult;
      }

      const policyDecision = evaluatePolicy(
        params.policy,
        action,
        observationBefore.url,
        target?.name
      );
      if (!policyDecision.allowed) {
        if (policyDecision.risk === 'irreversible' && params.handoffManager) {
          const intervention = await params.handoffManager.requestIntervention({
            runId: evidence.correlationId,
            goal: artifact.name,
            currentStep: step.id,
            reason: policyDecision.reason,
            screenshotPath: observationBefore.screenshotPath,
            observation: observationBefore,
            evidenceLinks: [evidence.runDir],
          });
          await adapter.enableHumanAudit((event) =>
            params.handoffManager?.recordAudit(
              intervention.interventionId,
              event
            )
          );
          params.handoffManager.claim(intervention.interventionId);
          if (!params.onInterventionRequested && !params.headed) {
            params.handoffManager.markAwaitingExternalResolution(
              intervention.interventionId
            );
            const result = replayResultSchema.parse({
              status: 'intervention_required',
              interventionId: intervention.interventionId,
              message: policyDecision.reason,
              correlationId: evidence.correlationId,
            });
            await evidence.writeJson('result.json', result);
            await evidence.writeManifest('replay', 'none');
            return result;
          }
          await params.onInterventionRequested?.({
            interventionId: intervention.interventionId,
            context: adapter.getContext(),
            page: adapter.getPage(),
          });
          const decision = await params.handoffManager.waitForResolution(
            intervention.interventionId
          );
          if (decision === 'abort') {
            const result = replayResultSchema.parse({
              status: 'intervention_required',
              interventionId: intervention.interventionId,
              message: 'Operator aborted replay during handoff.',
              correlationId: evidence.correlationId,
            });
            await evidence.writeJson('result.json', result);
            await evidence.writeManifest('replay', 'none');
            return result;
          }
          await withTimeout(
            adapter.perform({
              type: 'wait',
              ms: 100,
              rationale: 'flush human audit events',
            }),
            step.timeoutMs,
            `${step.id} handoff flush`
          );
          params.handoffManager.complete(intervention.interventionId);
          continue;
        }

        const result = failureResult(
          evidence.correlationId,
          {
            category: 'Policy violation',
            code: 'POLICY_DENIED',
            message: policyDecision.reason,
            stepId: step.id,
            expectedState: JSON.stringify(step.expectedPageState),
            observedState: observationBefore.url,
            recoverability: 'hard-failure',
          },
          await evidence.listFiles()
        );
        await evidence.writeJson('result.json', result);
        await evidence.writeManifest('replay', 'none');
        return result;
      }

      let attempt = 0;
      let executionError: Error | undefined;
      let extracted: string | undefined;
      while (attempt < step.retryPolicy.maxAttempts) {
        try {
          ensureWithinRunBudget(
            startedAt,
            params.policy.maxRunDurationMs,
            `${step.id} attempt ${attempt + 1}`
          );
          const execution = await withTimeout(
            adapter.perform(action, target),
            step.timeoutMs,
            `${step.id} attempt ${attempt + 1}`
          );
          extracted = execution.extracted;
          executionError = undefined;
          break;
        } catch (error) {
          executionError = error as Error;
          attempt += 1;
          await evidence.appendEvent({
            stepId: step.id,
            phase: 'retry',
            attempt,
            error: executionError.message,
          });
          if (attempt < step.retryPolicy.maxAttempts) {
            await withTimeout(
              adapter.perform({
                type: 'wait',
                ms: 500,
                rationale: 'bounded retry wait',
              }),
              step.timeoutMs,
              `${step.id} retry wait`
            );
          }
        }
      }
      if (executionError) {
        const result = failureResult(
          evidence.correlationId,
          {
            category: 'Transient timeout',
            code: 'STEP_EXECUTION_FAILED',
            message: executionError.message,
            stepId: step.id,
            expectedState: JSON.stringify(step.expectedPageState),
            observedState: (await adapter.observe()).visibleText.slice(0, 120),
            recoverability: 'recoverable',
          },
          await evidence.listFiles()
        );
        await evidence.writeJson('result.json', result);
        await evidence.writeManifest('replay', 'none');
        return result;
      }

      if (action.type === 'extract' && extracted) {
        outputs[action.outputKey] = extracted;
      }
      const dialogs = adapter.consumeDialogs();
      if (dialogs.length > 0) {
        const result = failureResult(
          evidence.correlationId,
          {
            category: 'Unexpected dialog',
            code: 'UNEXPECTED_DIALOG',
            message: dialogs.join('; '),
            stepId: step.id,
            expectedState: JSON.stringify(step.expectedPageState),
            observedState: dialogs.join('; '),
            recoverability: 'hard-failure',
          },
          await evidence.listFiles()
        );
        await evidence.writeJson('result.json', result);
        await evidence.writeManifest('replay', 'none');
        return result;
      }

      let observationAfter = await withTimeout(
        adapter.observe(
          join(evidence.runDir, 'screenshots'),
          `${step.id}-after`
        ),
        step.timeoutMs,
        `${step.id} post-action observation`
      );
      for (
        let checkpointAttempt = 1;
        checkpointAttempt < step.retryPolicy.maxAttempts;
        checkpointAttempt += 1
      ) {
        const checkpointSatisfied =
          (!step.expectedPageState.urlIncludes ||
            observationAfter.url.includes(
              step.expectedPageState.urlIncludes
            )) &&
          (!step.expectedPageState.textIncludes ||
            observationAfter.visibleText.includes(
              step.expectedPageState.textIncludes
            ));
        if (checkpointSatisfied) {
          break;
        }
        await evidence.appendEvent({
          stepId: step.id,
          phase: 'checkpoint-retry',
          attempt: checkpointAttempt,
        });
        await withTimeout(
          adapter.perform({
            type: 'wait',
            ms: 500,
            rationale: 'checkpoint retry wait',
          }),
          step.timeoutMs,
          `${step.id} checkpoint wait ${checkpointAttempt}`
        );
        observationAfter = await withTimeout(
          adapter.observe(
            join(evidence.runDir, 'screenshots'),
            `${step.id}-after-retry-${checkpointAttempt}`
          ),
          step.timeoutMs,
          `${step.id} checkpoint observation ${checkpointAttempt}`
        );
      }
      await evidence.appendEvent({
        stepId: step.id,
        phase: 'after',
        observation: sanitizeObject(observationAfter),
        outputs,
      });
      const postExecutionResult = detectObservationResult(
        evidence.correlationId,
        observationAfter,
        step.id,
        JSON.stringify(step.expectedPageState),
        await evidence.listFiles()
      );
      if (postExecutionResult) {
        await evidence.writeJson('result.json', postExecutionResult);
        await evidence.writeManifest('replay', 'none');
        return postExecutionResult;
      }

      if (
        step.expectedPageState.urlIncludes &&
        !observationAfter.url.includes(step.expectedPageState.urlIncludes)
      ) {
        const result = failureResult(
          evidence.correlationId,
          {
            category: 'Checkpoint failure',
            code: 'URL_CHECKPOINT_FAILED',
            message: `Expected URL to include ${step.expectedPageState.urlIncludes}`,
            stepId: step.id,
            expectedState: step.expectedPageState.urlIncludes,
            observedState: observationAfter.url,
            recoverability: 'hard-failure',
          },
          await evidence.listFiles()
        );
        await evidence.writeJson('result.json', result);
        await evidence.writeManifest('replay', 'none');
        return result;
      }
      if (
        step.expectedPageState.textIncludes &&
        !observationAfter.visibleText.includes(
          step.expectedPageState.textIncludes
        )
      ) {
        const result = failureResult(
          evidence.correlationId,
          {
            category: 'Checkpoint failure',
            code: 'TEXT_CHECKPOINT_FAILED',
            message: `Expected page text to include ${step.expectedPageState.textIncludes}`,
            stepId: step.id,
            expectedState: step.expectedPageState.textIncludes,
            observedState: observationAfter.visibleText.slice(0, 160),
            recoverability: 'hard-failure',
          },
          await evidence.listFiles()
        );
        await evidence.writeJson('result.json', result);
        await evidence.writeManifest('replay', 'none');
        return result;
      }
    }

    for (const output of artifact.outputContract.outputs) {
      if (!(output.name in outputs)) {
        throw new Error(`Missing declared output ${output.name}`);
      }
    }

    const result = replayResultSchema.parse({
      status: 'success',
      outputs,
      correlationId: evidence.correlationId,
    });
    await evidence.writeJson('result.json', result);
    await evidence.writeManifest('replay', 'none');
    return result;
  } catch (error) {
    const result = failureResult(
      evidence.correlationId,
      {
        category: 'Internal error',
        code: 'INTERNAL_ERROR',
        message: (error as Error).message,
        recoverability: 'hard-failure',
      },
      await evidence.listFiles().catch(() => [])
    );
    await evidence.writeJson('result.json', result);
    await evidence.writeManifest('replay', 'none');
    return result;
  } finally {
    await adapter.close();
  }
};
