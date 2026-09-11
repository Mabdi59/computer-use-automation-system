import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { BrowserContext, Page } from 'playwright';

import {
  artifactPayloadForChecksum,
  computeArtifactChecksum,
} from './core/checksum.js';
import { EvidenceWriter } from './core/evidence.js';
import { sanitizeObject } from './core/redaction.js';
import {
  capabilityArtifactSchema,
  discoveryRunResultSchema,
  llmActionSchema,
  type CapabilityArtifact,
  type DirectTarget,
  type LLMAction,
  type PolicyConfig,
} from './core/schemas.js';
import { parameterizeValue } from './core/template.js';
import { evaluatePolicy } from './core/policy.js';
import type { LLMProvider } from './providers/llm.js';
import type { InterventionRequest, HandoffManager } from './runtime/handoff.js';
import { PlaywrightSurfaceAdapter } from './surface/playwright.js';

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const inferInputs = (
  goal: string,
  explicitInputs: Record<string, string>
): Record<string, string> => {
  if (Object.keys(explicitInputs).length > 0) {
    return explicitInputs;
  }
  const memberMatch = goal.match(/member\s+(\d{4,})/i);
  return memberMatch ? { memberId: memberMatch[1] } : {};
};

const withTargetId = (target: DirectTarget): DirectTarget & { id: string } => ({
  ...target,
  id: slugify(target.name),
});

const getActionTarget = (action: LLMAction): DirectTarget | undefined =>
  'target' in action ? action.target : undefined;

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

const buildArtifactFromRun = (params: {
  goal: string;
  targetUrl: string;
  provider: LLMProvider;
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  actions: LLMAction[];
}): CapabilityArtifact => {
  const targets = new Map<string, ReturnType<typeof withTargetId>>();
  const steps: CapabilityArtifact['steps'] = params.actions
    .filter((action) => action.type !== 'finish' && action.type !== 'escalate')
    .map((action, index) => {
      const actionCopy = structuredClone(action) as LLMAction;
      if ('target' in actionCopy && actionCopy.target) {
        const target = withTargetId(actionCopy.target);
        targets.set(target.id, target);
        (actionCopy as Extract<LLMAction, { target?: DirectTarget }>).targetId =
          target.id;
        delete (actionCopy as Extract<LLMAction, { target?: DirectTarget }>)
          .target;
      }
      if ('value' in actionCopy) {
        actionCopy.value = parameterizeValue(actionCopy.value, params.inputs);
      }
      if ('url' in actionCopy && actionCopy.url) {
        actionCopy.url = parameterizeValue(actionCopy.url, params.inputs);
      }
      if ('expected' in actionCopy) {
        actionCopy.expected = parameterizeValue(
          actionCopy.expected,
          params.inputs
        );
      }
      return {
        id: `step-${index + 1}`,
        description: `${action.type} step ${index + 1}`,
        action: { ...actionCopy, rationale: action.rationale },
        risk:
          action.type === 'click' &&
          /confirm|submit/i.test(getActionTarget(action)?.name ?? '')
            ? 'irreversible'
            : 'safe',
        timeoutMs: 5_000,
        retryPolicy: { maxAttempts: action.type === 'assert' ? 2 : 1 },
        expectedPageState:
          action.type === 'assert' && action.condition === 'urlIncludes'
            ? { urlIncludes: action.expected }
            : action.type === 'assert' && action.condition === 'containsText'
              ? { textIncludes: action.expected }
              : {},
        checkpoint:
          action.type === 'assert' ? `checkpoint-${index + 1}` : undefined,
      };
    });

  const checkpoints = steps
    .map((step) => step.checkpoint)
    .filter((value): value is string => Boolean(value));
  const artifactWithoutIntegrity: Omit<CapabilityArtifact, 'integrity'> = {
    schemaVersion: '1.0.0' as const,
    capabilityId: slugify(params.goal).slice(0, 60),
    name: params.goal,
    description: `Discovered capability for ${params.goal}`,
    revision: 1,
    vendor: {
      name: 'Synthetic Credit Union',
      application: 'Legacy Servicing Portal',
      variant: 'mock-local',
    },
    compatibleVersions: ['legacy-v1'],
    approvalState: 'draft' as const,
    riskClassification: 'safe' as const,
    inputParameters: Object.entries(params.inputs).map(([name, value]) => ({
      name,
      type: 'string' as const,
      required: true,
      description: `Runtime input captured from discovery for ${name}`,
      pattern: /^\d+$/.test(value) ? '^\\d+$' : undefined,
    })),
    outputContract: {
      outputs: Object.keys(params.outputs).map((name) => ({
        name,
        type: 'string' as const,
        description: `Extracted output ${name}`,
      })),
      allowedBusinessOutcomes: ['MEMBER_NOT_FOUND'],
    },
    preconditions: ['Synthetic target app is running locally on 127.0.0.1.'],
    steps,
    targets: Array.from(targets.values()),
    checkpoints: checkpoints.length > 0 ? checkpoints : ['final-output'],
    successCondition: {
      type: 'output_present' as const,
      outputKey: Object.keys(params.outputs)[0] ?? 'result',
    },
    businessOutcomeDetectors: [
      {
        code: 'MEMBER_NOT_FOUND',
        description: 'Member search completed without a synthetic match.',
        matchText: 'No synthetic member matched',
      },
    ],
    recoverableConditionHandlers: [
      {
        category: 'Transient timeout' as const,
        strategy: 'retry' as const,
        maxAttempts: 2,
      },
    ],
    redaction: {
      sensitiveFields: ['password', 'payment', 'ssn'],
      secretPatterns: ['token', 'cookie'],
    },
    defaults: { baseUrl: params.targetUrl, targetRoute: '/' },
    overrides: [
      {
        tenant: 'synthetic-default',
        compatibleVersions: ['legacy-v1'],
        targetRoute: '/',
      },
    ],
    createdAt: new Date().toISOString(),
    createdBy: {
      mode:
        params.provider.name === 'openai'
          ? ('openai-live' as const)
          : ('scripted-test' as const),
      provider: params.provider.name,
      model: params.provider.model,
    },
  };

  const provisionalArtifact = capabilityArtifactSchema.parse({
    ...artifactWithoutIntegrity,
    integrity: { algorithm: 'sha256' as const, checksum: 'pending' },
  });
  const checksum = computeArtifactChecksum(
    artifactPayloadForChecksum(provisionalArtifact)
  );
  return capabilityArtifactSchema.parse({
    ...provisionalArtifact,
    integrity: { algorithm: 'sha256' as const, checksum },
  });
};

export const runDiscovery = async (params: {
  goal: string;
  targetUrl: string;
  provider: LLMProvider;
  policy: PolicyConfig;
  evidenceBaseDir: string;
  artifactPath: string;
  headed?: boolean;
  inputHints?: Record<string, string>;
  handoffManager?: HandoffManager;
  onInterventionRequested?: (context: {
    intervention: InterventionRequest;
    browserContext: BrowserContext;
    page: Page;
  }) => Promise<void>;
}): Promise<ReturnType<typeof discoveryRunResultSchema.parse>> => {
  const evidence = new EvidenceWriter(params.evidenceBaseDir);
  await evidence.init({
    goal: params.goal,
    mode: params.provider.name === 'openai' ? 'openai-live' : 'scripted-test',
  });

  const adapter = await PlaywrightSurfaceAdapter.launch({
    targetUrl: params.targetUrl,
    headed: params.headed,
  });
  const outputs: Record<string, string> = {};
  const actions: LLMAction[] = [];
  const inputs = inferInputs(params.goal, params.inputHints ?? {});
  const seenActions = new Map<string, number>();
  const startedAt = Date.now();

  try {
    for (let step = 1; step <= params.policy.maxSteps; step += 1) {
      ensureWithinRunBudget(
        startedAt,
        params.policy.maxRunDurationMs,
        `step ${step} observation`
      );
      const observation = await withTimeout(
        adapter.observe(join(evidence.runDir, 'screenshots'), `step-${step}`),
        params.policy.perStepTimeoutMs,
        `discovery observation ${step}`
      );
      await evidence.appendEvent({
        step,
        phase: 'observe',
        observation: sanitizeObject(observation),
      });

      if (observation.visibleText.includes('No synthetic member matched')) {
        const result = {
          status: 'business_outcome',
          code: 'MEMBER_NOT_FOUND',
          message: 'Member was not found in synthetic application.',
        };
        await evidence.writeJson('result.json', result);
        await evidence.writeManifest('scripted-test', params.provider.name);
        return discoveryRunResultSchema.parse(result);
      }

      ensureWithinRunBudget(
        startedAt,
        params.policy.maxRunDurationMs,
        `step ${step} llm action`
      );
      const action = llmActionSchema.parse(
        await withTimeout(
          params.provider.nextAction({
            goal: params.goal,
            observation: sanitizeObject(observation),
            previousActions: actions,
          }),
          params.policy.perStepTimeoutMs,
          `llm action ${step}`
        )
      );
      const actionKey = JSON.stringify(action);
      seenActions.set(actionKey, (seenActions.get(actionKey) ?? 0) + 1);
      if ((seenActions.get(actionKey) ?? 0) > 3) {
        const result = {
          status: 'failure',
          category: 'Internal error',
          message: 'Discovery stopped after repeated actions.',
        };
        await evidence.writeJson('result.json', result);
        await evidence.writeManifest('scripted-test', params.provider.name);
        return discoveryRunResultSchema.parse(result);
      }

      const policyDecision = evaluatePolicy(
        params.policy,
        action,
        observation.url,
        getActionTarget(action)?.name
      );
      await evidence.appendEvent({
        step,
        phase: 'policy',
        action,
        policyDecision,
      });
      if (!policyDecision.allowed) {
        if (policyDecision.risk === 'irreversible' && params.handoffManager) {
          const intervention = await params.handoffManager.requestIntervention({
            runId: evidence.correlationId,
            goal: params.goal,
            currentStep: `step-${step}`,
            reason: policyDecision.reason,
            screenshotPath: observation.screenshotPath,
            observation,
            evidenceLinks: [evidence.runDir],
          });
          await adapter.enableHumanAudit((event) =>
            params.handoffManager?.recordAudit(
              intervention.interventionId,
              event
            )
          );
          await evidence.appendEvent({
            step,
            phase: 'handoff',
            interventionId: intervention.interventionId,
          });
          if (!params.onInterventionRequested && !params.headed) {
            params.handoffManager.markAwaitingExternalResolution(
              intervention.interventionId
            );
            const result = {
              status: 'intervention_required',
              interventionId: intervention.interventionId,
              message: policyDecision.reason,
            };
            await evidence.writeJson('result.json', result);
            await evidence.writeManifest('scripted-test', params.provider.name);
            return discoveryRunResultSchema.parse(result);
          }
          params.handoffManager.claim(intervention.interventionId);
          await params.onInterventionRequested?.({
            intervention,
            browserContext: adapter.getContext(),
            page: adapter.getPage(),
          });
          const decision = await params.handoffManager.waitForResolution(
            intervention.interventionId
          );
          if (decision === 'abort') {
            const result = {
              status: 'intervention_required',
              interventionId: intervention.interventionId,
              message: 'Operator aborted the discovery run.',
            };
            await evidence.writeJson('result.json', result);
            await evidence.writeManifest('scripted-test', params.provider.name);
            return discoveryRunResultSchema.parse(result);
          }
          params.handoffManager.complete(intervention.interventionId);
          continue;
        }

        const result = {
          status: 'failure',
          category: 'Policy violation',
          message: policyDecision.reason,
        };
        await evidence.writeJson('result.json', result);
        await evidence.writeManifest('scripted-test', params.provider.name);
        return discoveryRunResultSchema.parse(result);
      }

      if (action.type === 'finish') {
        if (action.status === 'business_outcome') {
          const result = {
            status: 'business_outcome',
            code: action.outcomeCode ?? 'BUSINESS_OUTCOME',
            message: action.reason,
          };
          await evidence.writeJson('result.json', result);
          await evidence.writeManifest('scripted-test', params.provider.name);
          return discoveryRunResultSchema.parse(result);
        }
        const artifact = buildArtifactFromRun({
          goal: params.goal,
          targetUrl: params.targetUrl,
          provider: params.provider,
          inputs,
          outputs,
          actions,
        });
        await mkdir(dirname(params.artifactPath), { recursive: true });
        await writeFile(params.artifactPath, JSON.stringify(artifact, null, 2));
        evidence.registerFile(params.artifactPath);
        await evidence.writeJson(
          `generated-${basename(params.artifactPath)}`,
          artifact
        );
        const result = {
          status: 'success',
          artifactPath: params.artifactPath,
          outputs,
        };
        await evidence.writeJson('result.json', result);
        await evidence.writeManifest(
          artifact.createdBy.mode,
          params.provider.name
        );
        return discoveryRunResultSchema.parse(result);
      }

      if (action.type === 'escalate') {
        if (!params.handoffManager) {
          const result = {
            status: 'intervention_required',
            interventionId: 'unavailable',
            message: action.reason,
          };
          await evidence.writeJson('result.json', result);
          await evidence.writeManifest('scripted-test', params.provider.name);
          return discoveryRunResultSchema.parse(result);
        }
        const intervention = await params.handoffManager.requestIntervention({
          runId: evidence.correlationId,
          goal: params.goal,
          currentStep: `step-${step}`,
          reason: action.reason,
          screenshotPath: observation.screenshotPath,
          observation,
          evidenceLinks: [evidence.runDir],
        });
        await adapter.enableHumanAudit((event) =>
          params.handoffManager?.recordAudit(intervention.interventionId, event)
        );
        if (!params.onInterventionRequested && !params.headed) {
          params.handoffManager.markAwaitingExternalResolution(
            intervention.interventionId
          );
          const result = {
            status: 'intervention_required',
            interventionId: intervention.interventionId,
            message: action.reason,
          };
          await evidence.writeJson('result.json', result);
          await evidence.writeManifest('scripted-test', params.provider.name);
          return discoveryRunResultSchema.parse(result);
        }
        params.handoffManager.claim(intervention.interventionId);
        await params.onInterventionRequested?.({
          intervention,
          browserContext: adapter.getContext(),
          page: adapter.getPage(),
        });
        const decision = await params.handoffManager.waitForResolution(
          intervention.interventionId
        );
        if (decision === 'abort') {
          const result = {
            status: 'intervention_required',
            interventionId: intervention.interventionId,
            message: 'Operator aborted the discovery run.',
          };
          await evidence.writeJson('result.json', result);
          await evidence.writeManifest('scripted-test', params.provider.name);
          return discoveryRunResultSchema.parse(result);
        }
        params.handoffManager.complete(intervention.interventionId);
        continue;
      }

      ensureWithinRunBudget(
        startedAt,
        params.policy.maxRunDurationMs,
        `step ${step} execution`
      );
      const execution = await withTimeout(
        adapter.perform(action, getActionTarget(action)),
        params.policy.perStepTimeoutMs,
        `discovery action ${step}`
      );
      if (action.type === 'extract' && execution.extracted) {
        outputs[action.outputKey] = execution.extracted;
      }
      actions.push(action);
      await evidence.appendEvent({
        step,
        phase: 'action',
        action,
        executionResult: sanitizeObject(execution),
      });
    }

    const result = {
      status: 'failure',
      category: 'Internal error',
      message: 'Discovery hit the maximum step limit.',
    };
    await evidence.writeJson('result.json', result);
    await evidence.writeManifest('scripted-test', params.provider.name);
    return discoveryRunResultSchema.parse(result);
  } catch (error) {
    const result = {
      status: 'failure',
      category: 'Internal error',
      message: (error as Error).message,
    };
    await evidence.writeJson('result.json', result);
    await evidence.writeManifest('scripted-test', params.provider.name);
    return discoveryRunResultSchema.parse(result);
  } finally {
    await adapter.close();
  }
};
