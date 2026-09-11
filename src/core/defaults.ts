import { policySchema, type PolicyConfig } from './schemas.js';

export const createDefaultPolicy = (): PolicyConfig =>
  policySchema.parse({
    allowedProtocols: ['http'],
    allowedHosts: ['127.0.0.1'],
    allowedPorts: [3000],
    allowedRoutes: ['/', '/app'],
    allowedFrameOrigins: ['http://127.0.0.1:3000'],
    allowedActionTypes: ['navigate', 'click', 'type', 'select', 'wait', 'extract', 'assert', 'finish', 'escalate'],
    maxSteps: 12,
    maxRunDurationMs: 30_000,
    perStepTimeoutMs: 5_000,
    sensitiveFieldPatterns: ['password', 'payment', 'ssn', 'social security'],
    allowSensitiveInput: false,
    allowIrreversibleActions: false,
    requireHumanApprovalForIrreversible: true,
    redactOutputPatterns: ['token', 'cookie'],
  });
