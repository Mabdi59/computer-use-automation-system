import { computeArtifactChecksum } from './core/checksum.js';
import { capabilityArtifactSchema, type CapabilityArtifact } from './core/schemas.js';

export const buildExampleMemberBalanceArtifact = (baseUrl: string): CapabilityArtifact => {
  const withoutIntegrity: Omit<CapabilityArtifact, 'integrity'> = {
    schemaVersion: '1.0.0',
    capabilityId: 'member-balance-lookup',
    name: 'Look up synthetic member balance',
    description: 'Looks up synthetic member details and extracts the savings balance from the legacy frame.',
    revision: 1,
    vendor: { name: 'Synthetic Credit Union', application: 'Legacy Servicing Portal', variant: 'mock-local' },
    compatibleVersions: ['legacy-v1'],
    approvalState: 'approved',
    riskClassification: 'safe',
    inputParameters: [{ name: 'memberId', type: 'string', required: true, description: 'Synthetic member id', pattern: '^\\d+$' }],
    outputContract: {
      outputs: [{ name: 'savingsBalance', type: 'string', description: 'Savings balance value' }],
      allowedBusinessOutcomes: ['MEMBER_NOT_FOUND'],
    },
    preconditions: ['Synthetic target app available locally on 127.0.0.1.'],
    targets: [
      {
        id: 'member-search-link',
        name: 'Member Search link',
        description: 'Legacy home navigation link',
        stableReason: 'Stable navigation text inside the application frame.',
        risk: 'safe',
        priority: [
          { kind: 'text', text: 'Member Search', frameName: 'legacy-app-frame' },
          { kind: 'role', role: 'link', name: 'Member Search', frameName: 'legacy-app-frame' },
        ],
      },
      {
        id: 'member-id-input',
        name: 'Member ID input',
        description: 'Legacy member id field',
        stableReason: 'Stable label rendered by the legacy search form inside a same-origin iframe.',
        risk: 'safe',
        priority: [
          { kind: 'label', label: 'Member ID', frameName: 'legacy-app-frame' },
          { kind: 'css', css: 'input[name="memberId"]', frameName: 'legacy-app-frame' },
        ],
      },
      {
        id: 'search-member-button',
        name: 'Search Member button',
        description: 'Search form submit button',
        stableReason: 'Stable action verb in the legacy workflow.',
        risk: 'safe',
        priority: [
          { kind: 'role', role: 'button', name: 'Search Member', frameName: 'legacy-app-frame' },
          { kind: 'text', text: 'Search Member', frameName: 'legacy-app-frame' },
        ],
      },
      {
        id: 'savings-balance-label',
        name: 'Savings balance label',
        description: 'Row label confirming details page',
        stableReason: 'Stable visible row label for the balance field.',
        risk: 'safe',
        priority: [{ kind: 'text', text: 'Savings Balance', frameName: 'legacy-app-frame' }],
      },
      {
        id: 'savings-balance-value',
        name: 'Savings balance value',
        description: 'Balance value cell',
        stableReason: 'Anchored by a stable id with visible-text fallback.',
        risk: 'safe',
        priority: [
          { kind: 'css', css: '#savings-balance', frameName: 'legacy-app-frame' },
          { kind: 'text', text: '$1,234.56', frameName: 'legacy-app-frame' },
        ],
      },
    ],
    steps: [
      { id: 'step-1', description: 'Open application shell', action: { type: 'navigate', url: `${baseUrl}/`, rationale: 'artifact step' }, risk: 'safe', timeoutMs: 5000, retryPolicy: { maxAttempts: 1 }, expectedPageState: {} },
      { id: 'step-2', description: 'Open member search', action: { type: 'click', targetId: 'member-search-link', rationale: 'artifact step' }, risk: 'safe', timeoutMs: 5000, retryPolicy: { maxAttempts: 2 }, expectedPageState: { textIncludes: 'Member ID' } },
      { id: 'step-3', description: 'Enter member id', action: { type: 'type', targetId: 'member-id-input', value: '{{memberId}}', sensitive: false, rationale: 'artifact step' }, risk: 'safe', timeoutMs: 5000, retryPolicy: { maxAttempts: 1 }, expectedPageState: {} },
      { id: 'step-4', description: 'Submit member search', action: { type: 'click', targetId: 'search-member-button', rationale: 'artifact step' }, risk: 'safe', timeoutMs: 5000, retryPolicy: { maxAttempts: 1 }, expectedPageState: {} },
      { id: 'step-5', description: 'Verify details page', action: { type: 'assert', targetId: 'savings-balance-label', condition: 'containsText', expected: 'Savings Balance', rationale: 'artifact step' }, risk: 'safe', timeoutMs: 5000, retryPolicy: { maxAttempts: 2 }, expectedPageState: { textIncludes: 'Savings Balance' }, checkpoint: 'member-details-loaded' },
      { id: 'step-6', description: 'Extract savings balance', action: { type: 'extract', targetId: 'savings-balance-value', outputKey: 'savingsBalance', rationale: 'artifact step' }, risk: 'safe', timeoutMs: 5000, retryPolicy: { maxAttempts: 1 }, expectedPageState: { textIncludes: '$1,234.56' } },
    ],
    checkpoints: ['member-details-loaded'],
    successCondition: { type: 'output_present', outputKey: 'savingsBalance' },
    businessOutcomeDetectors: [{ code: 'MEMBER_NOT_FOUND', description: 'Search completed without a synthetic member match.', matchText: 'No synthetic member matched' }],
    recoverableConditionHandlers: [{ category: 'Transient timeout', strategy: 'retry', maxAttempts: 2 }],
    redaction: { sensitiveFields: ['password', 'payment', 'ssn'], secretPatterns: ['token', 'cookie'] },
    defaults: { baseUrl, targetRoute: '/' },
    overrides: [{ tenant: 'synthetic-default', compatibleVersions: ['legacy-v1'], targetRoute: '/' }],
    createdAt: new Date().toISOString(),
    createdBy: { mode: 'scripted-test', provider: 'example-artifact', model: 'scripted-test' },
  };

  return capabilityArtifactSchema.parse({
    ...withoutIntegrity,
    integrity: { algorithm: 'sha256', checksum: computeArtifactChecksum(withoutIntegrity) },
  });
};

export const buildOpenSubAccountArtifact = (baseUrl: string): CapabilityArtifact => {
  const withoutIntegrity: Omit<CapabilityArtifact, 'integrity'> = {
    schemaVersion: '1.0.0',
    capabilityId: 'open-sub-account-review',
    name: 'Open synthetic sub-account to review',
    description: 'Navigates a synthetic operator to the review page and blocks final confirmation.',
    revision: 1,
    vendor: { name: 'Synthetic Credit Union', application: 'Legacy Servicing Portal', variant: 'mock-local' },
    compatibleVersions: ['legacy-v1'],
    approvalState: 'draft',
    riskClassification: 'irreversible',
    inputParameters: [{ name: 'memberId', type: 'string', required: true, description: 'Synthetic member id', pattern: '^\\d+$' }],
    outputContract: { outputs: [{ name: 'reviewState', type: 'string', description: 'Review page text' }], allowedBusinessOutcomes: [] },
    preconditions: ['Synthetic target app available locally.'],
    targets: [
      {
        id: 'member-search-link',
        name: 'Member Search link',
        description: 'Legacy home navigation link',
        stableReason: 'Stable navigation text inside the application frame.',
        risk: 'safe',
        priority: [{ kind: 'text', text: 'Member Search', frameName: 'legacy-app-frame' }],
      },
      {
        id: 'member-id-input',
        name: 'Member ID input',
        description: 'Legacy member id field',
        stableReason: 'Stable visible label in a server-rendered frame.',
        risk: 'safe',
        priority: [
          { kind: 'label', label: 'Member ID', frameName: 'legacy-app-frame' },
          { kind: 'css', css: 'input[name="memberId"]', frameName: 'legacy-app-frame' },
        ],
      },
      {
        id: 'search-member-button',
        name: 'Search Member button',
        description: 'Submits member search form',
        stableReason: 'Stable button text in frame.',
        risk: 'safe',
        priority: [{ kind: 'role', role: 'button', name: 'Search Member', frameName: 'legacy-app-frame' }],
      },
      {
        id: 'open-sub-account-link',
        name: 'Open Sub-Account link',
        description: 'Starts the flow from member details page',
        stableReason: 'Stable link text in legacy action region.',
        risk: 'safe',
        priority: [{ kind: 'text', text: 'Open Sub-Account', frameName: 'legacy-app-frame' }],
      },
      {
        id: 'continue-button',
        name: 'Continue button',
        description: 'Advances to review page',
        stableReason: 'Stable submit label in wizard.',
        risk: 'safe',
        priority: [{ kind: 'role', role: 'button', name: 'Continue', frameName: 'legacy-app-frame' }],
      },
      {
        id: 'confirm-submission-button',
        name: 'Confirm Submission button',
        description: 'Irreversible confirmation point',
        stableReason: 'Stable button text on review page.',
        risk: 'irreversible',
        priority: [{ kind: 'role', role: 'button', name: 'Confirm Submission', frameName: 'legacy-app-frame' }],
      },
      {
        id: 'review-text',
        name: 'Review text',
        description: 'Review page evidence text',
        stableReason: 'Stable review banner text.',
        risk: 'safe',
        priority: [{ kind: 'text', text: 'Synthetic only. No real transaction will be executed.', frameName: 'legacy-app-frame' }],
      },
    ],
    steps: [
      { id: 'step-1', description: 'Open application shell', action: { type: 'navigate', url: `${baseUrl}/`, rationale: 'artifact step' }, risk: 'safe', timeoutMs: 5000, retryPolicy: { maxAttempts: 1 }, expectedPageState: {} },
      { id: 'step-2', description: 'Open member search', action: { type: 'click', targetId: 'member-search-link', rationale: 'artifact step' }, risk: 'safe', timeoutMs: 5000, retryPolicy: { maxAttempts: 2 }, expectedPageState: { textIncludes: 'Member ID' } },
      { id: 'step-3', description: 'Type member id', action: { type: 'type', targetId: 'member-id-input', value: '{{memberId}}', sensitive: false, rationale: 'artifact step' }, risk: 'safe', timeoutMs: 5000, retryPolicy: { maxAttempts: 1 }, expectedPageState: {} },
      { id: 'step-4', description: 'Search member', action: { type: 'click', targetId: 'search-member-button', rationale: 'artifact step' }, risk: 'safe', timeoutMs: 5000, retryPolicy: { maxAttempts: 2 }, expectedPageState: { textIncludes: 'Savings Balance' } },
      { id: 'step-5', description: 'Open sub-account flow', action: { type: 'click', targetId: 'open-sub-account-link', rationale: 'artifact step' }, risk: 'safe', timeoutMs: 5000, retryPolicy: { maxAttempts: 1 }, expectedPageState: { textIncludes: 'Open Sub-Account - Step 1' } },
      { id: 'step-6', description: 'Continue to review', action: { type: 'click', targetId: 'continue-button', rationale: 'artifact step' }, risk: 'safe', timeoutMs: 5000, retryPolicy: { maxAttempts: 2 }, expectedPageState: { textIncludes: 'Open Sub-Account - Review' } },
      { id: 'step-7', description: 'Require approval before confirm', action: { type: 'click', targetId: 'confirm-submission-button', rationale: 'artifact step' }, risk: 'irreversible', timeoutMs: 5000, retryPolicy: { maxAttempts: 1 }, expectedPageState: { textIncludes: 'Confirm Submission' } },
      { id: 'step-8', description: 'Capture review banner', action: { type: 'extract', targetId: 'review-text', outputKey: 'reviewState', rationale: 'artifact step' }, risk: 'safe', timeoutMs: 5000, retryPolicy: { maxAttempts: 1 }, expectedPageState: { textIncludes: 'Synthetic only. No real transaction will be executed.' } },
    ],
    checkpoints: ['review-page'],
    successCondition: { type: 'output_present', outputKey: 'reviewState' },
    businessOutcomeDetectors: [],
    recoverableConditionHandlers: [],
    redaction: { sensitiveFields: ['password', 'payment', 'ssn'], secretPatterns: ['token', 'cookie'] },
    defaults: { baseUrl, targetRoute: '/' },
    overrides: [{ tenant: 'synthetic-default', compatibleVersions: ['legacy-v1'], targetRoute: '/' }],
    createdAt: new Date().toISOString(),
    createdBy: { mode: 'scripted-test', provider: 'manual-example', model: 'scripted-test' },
  };

  return capabilityArtifactSchema.parse({
    ...withoutIntegrity,
    integrity: { algorithm: 'sha256', checksum: computeArtifactChecksum(withoutIntegrity) },
  });
};
