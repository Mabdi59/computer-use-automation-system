import { z } from 'zod';

export const riskClassificationSchema = z.enum([
  'safe',
  'sensitive',
  'irreversible',
]);
export const approvalStateSchema = z.enum(['draft', 'approved']);
export const actionTypeSchema = z.enum([
  'navigate',
  'click',
  'type',
  'select',
  'wait',
  'extract',
  'assert',
  'finish',
  'escalate',
]);

const frameRefSchema = z.object({
  frameName: z.string().min(1).optional(),
  frameUrlIncludes: z.string().min(1).optional(),
});

const roleLocatorSchema = z.object({
  kind: z.literal('role'),
  role: z.enum(['button', 'link', 'textbox', 'combobox', 'cell', 'heading']),
  name: z.string().min(1),
  ...frameRefSchema.shape,
});

const labelLocatorSchema = z.object({
  kind: z.literal('label'),
  label: z.string().min(1),
  controlType: z.enum(['input', 'select', 'textarea']).optional(),
  ...frameRefSchema.shape,
});

const textLocatorSchema = z.object({
  kind: z.literal('text'),
  text: z.string().min(1),
  scopeText: z.string().min(1).optional(),
  ...frameRefSchema.shape,
});

const cssLocatorSchema = z.object({
  kind: z.literal('css'),
  css: z.string().min(1),
  ...frameRefSchema.shape,
});

const visualLocatorSchema = z.object({
  kind: z.literal('visual'),
  hint: z.string().min(1),
});

export const locatorSchema = z.union([
  roleLocatorSchema,
  labelLocatorSchema,
  textLocatorSchema,
  cssLocatorSchema,
  visualLocatorSchema,
]);

export const locatorBundleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  stableReason: z.string().min(1),
  risk: riskClassificationSchema.default('safe'),
  priority: z.array(locatorSchema).min(1),
});

export const directTargetSchema = locatorBundleSchema.omit({ id: true });

const navigateActionSchema = z.object({
  type: z.literal('navigate'),
  url: z.string().url().optional(),
  route: z.string().min(1).optional(),
  rationale: z.string().min(1).max(240),
});

const targetableActionBase = z.object({
  targetId: z.string().min(1).optional(),
  target: directTargetSchema.optional(),
  rationale: z.string().min(1).max(240),
});

const clickActionSchema = targetableActionBase.extend({
  type: z.literal('click'),
});

const typeActionSchema = targetableActionBase.extend({
  type: z.literal('type'),
  value: z.string(),
  sensitive: z.boolean().default(false),
});

const selectActionSchema = targetableActionBase.extend({
  type: z.literal('select'),
  value: z.string(),
});

const waitActionSchema = z.object({
  type: z.literal('wait'),
  ms: z.number().int().min(50).max(30_000).default(500),
  rationale: z.string().min(1).max(240),
});

const extractActionSchema = targetableActionBase.extend({
  type: z.literal('extract'),
  outputKey: z.string().min(1),
  pattern: z.string().min(1).optional(),
});

const assertActionSchema = targetableActionBase.extend({
  type: z.literal('assert'),
  condition: z.enum(['visible', 'containsText', 'urlIncludes']),
  expected: z.string().min(1),
});

const finishActionSchema = z.object({
  type: z.literal('finish'),
  status: z.enum(['success', 'business_outcome']),
  reason: z.string().min(1),
  outcomeCode: z.string().min(1).optional(),
  rationale: z.string().min(1).max(240),
});

const escalateActionSchema = z.object({
  type: z.literal('escalate'),
  reason: z.string().min(1),
  requiresHuman: z.boolean().default(true),
  rationale: z.string().min(1).max(240),
});

export const llmActionSchema = z.discriminatedUnion('type', [
  navigateActionSchema,
  clickActionSchema,
  typeActionSchema,
  selectActionSchema,
  waitActionSchema,
  extractActionSchema,
  assertActionSchema,
  finishActionSchema,
  escalateActionSchema,
]);

export const inputParameterSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean']),
  required: z.boolean().default(true),
  description: z.string().min(1),
  pattern: z.string().optional(),
});

export const outputFieldSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string().min(1),
});

export const artifactStepSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  action: llmActionSchema,
  risk: riskClassificationSchema.default('safe'),
  timeoutMs: z.number().int().min(100).max(60_000).default(5_000),
  retryPolicy: z
    .object({ maxAttempts: z.number().int().min(1).max(3).default(1) })
    .default({ maxAttempts: 1 }),
  expectedPageState: z
    .object({
      urlIncludes: z.string().optional(),
      textIncludes: z.string().optional(),
    })
    .default({}),
  checkpoint: z.string().optional(),
});

export const businessOutcomeDetectorSchema = z.object({
  code: z.string().min(1),
  description: z.string().min(1),
  matchText: z.string().optional(),
  urlIncludes: z.string().optional(),
});

export const recoverableConditionSchema = z.object({
  category: z.enum(['Transient timeout', 'Unexpected dialog']),
  strategy: z.enum(['retry', 'dismiss_dialog']),
  matchText: z.string().optional(),
  maxAttempts: z.number().int().min(1).max(3).default(1),
});

export const capabilityArtifactSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  capabilityId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  revision: z.number().int().min(1),
  vendor: z.object({
    name: z.string().min(1),
    application: z.string().min(1),
    variant: z.string().min(1).optional(),
  }),
  compatibleVersions: z.array(z.string().min(1)).min(1),
  approvalState: approvalStateSchema,
  riskClassification: riskClassificationSchema,
  inputParameters: z.array(inputParameterSchema),
  outputContract: z.object({
    outputs: z.array(outputFieldSchema),
    allowedBusinessOutcomes: z.array(z.string().min(1)).default([]),
  }),
  preconditions: z.array(z.string().min(1)).min(1),
  steps: z.array(artifactStepSchema).min(1),
  targets: z.array(locatorBundleSchema).min(1),
  checkpoints: z.array(z.string().min(1)).min(1),
  successCondition: z.object({
    type: z.enum(['output_present', 'page_text']),
    outputKey: z.string().optional(),
    expectedText: z.string().optional(),
  }),
  businessOutcomeDetectors: z.array(businessOutcomeDetectorSchema).default([]),
  recoverableConditionHandlers: z.array(recoverableConditionSchema).default([]),
  redaction: z.object({
    sensitiveFields: z.array(z.string().min(1)).default([]),
    secretPatterns: z.array(z.string().min(1)).default([]),
  }),
  defaults: z.object({
    baseUrl: z.string().url(),
    targetRoute: z.string().min(1),
  }),
  overrides: z
    .array(
      z.object({
        tenant: z.string().min(1),
        compatibleVersions: z.array(z.string().min(1)).default([]),
        targetRoute: z.string().min(1).optional(),
      })
    )
    .default([]),
  createdAt: z.string().min(1),
  createdBy: z.object({
    mode: z.enum(['openai-live', 'scripted-test']),
    provider: z.string().min(1),
    model: z.string().min(1),
  }),
  integrity: z.object({
    algorithm: z.literal('sha256'),
    checksum: z.string().min(1),
  }),
});

export const policySchema = z.object({
  allowedProtocols: z.array(z.string().min(1)).min(1),
  allowedHosts: z.array(z.string().min(1)).min(1),
  allowedPorts: z.array(z.number().int().min(1)).min(1),
  allowedRoutes: z.array(z.string().min(1)).min(1),
  allowedFrameOrigins: z.array(z.string().min(1)).min(1),
  allowedActionTypes: z.array(actionTypeSchema).min(1),
  maxSteps: z.number().int().min(1).max(100).default(12),
  maxRunDurationMs: z.number().int().min(1000).max(120_000).default(30_000),
  perStepTimeoutMs: z.number().int().min(100).max(60_000).default(5_000),
  sensitiveFieldPatterns: z
    .array(z.string().min(1))
    .default(['password', 'payment', 'ssn', 'social security']),
  allowSensitiveInput: z.boolean().default(false),
  allowIrreversibleActions: z.boolean().default(false),
  requireHumanApprovalForIrreversible: z.boolean().default(true),
  redactOutputPatterns: z.array(z.string().min(1)).default([]),
});

export const observationSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  visibleText: z.string(),
  elementSummary: z.array(z.string()),
  frames: z.array(z.object({ name: z.string(), url: z.string() })),
  dialogs: z.array(z.string()),
  screenshotPath: z.string().optional(),
});

export const discoveryRunResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    artifactPath: z.string().min(1),
    outputs: z.record(z.string(), z.string()),
  }),
  z.object({
    status: z.literal('business_outcome'),
    code: z.string().min(1),
    message: z.string().min(1),
  }),
  z.object({
    status: z.literal('failure'),
    message: z.string().min(1),
    category: z.string().min(1),
  }),
  z.object({
    status: z.literal('intervention_required'),
    interventionId: z.string().min(1),
    message: z.string().min(1),
  }),
]);

export const replayResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    outputs: z.record(z.string(), z.string()),
    correlationId: z.string().min(1),
  }),
  z.object({
    status: z.literal('business_outcome'),
    code: z.string().min(1),
    message: z.string().min(1),
    correlationId: z.string().min(1),
  }),
  z.object({
    status: z.literal('failure'),
    category: z.enum([
      'Business outcome',
      'Validation error',
      'Permission denial',
      'Session expiration',
      'Transient timeout',
      'Unexpected dialog',
      'Target not found',
      'Checkpoint failure',
      'Policy violation',
      'Application error',
      'Internal error',
    ]),
    code: z.string().min(1),
    message: z.string().min(1),
    stepId: z.string().min(1).optional(),
    expectedState: z.string().optional(),
    observedState: z.string().optional(),
    recoverability: z.enum(['recoverable', 'hard-failure']),
    evidencePaths: z.array(z.string()),
    correlationId: z.string().min(1),
  }),
  z.object({
    status: z.literal('intervention_required'),
    interventionId: z.string().min(1),
    message: z.string().min(1),
    correlationId: z.string().min(1),
  }),
]);

export type CapabilityArtifact = z.infer<typeof capabilityArtifactSchema>;
export type DirectTarget = z.infer<typeof directTargetSchema>;
export type LLMAction = z.infer<typeof llmActionSchema>;
export type Locator = z.infer<typeof locatorSchema>;
export type LocatorBundle = z.infer<typeof locatorBundleSchema>;
export type Observation = z.infer<typeof observationSchema>;
export type PolicyConfig = z.infer<typeof policySchema>;
export type ReplayResult = z.infer<typeof replayResultSchema>;
