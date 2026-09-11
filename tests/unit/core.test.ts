import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { verifyArtifactChecksum } from '../../src/core/checksum.js';
import { createDefaultPolicy } from '../../src/core/defaults.js';
import { redactFieldValue, redactText, sanitizeObject } from '../../src/core/redaction.js';
import { capabilityArtifactSchema } from '../../src/core/schemas.js';
import { evaluatePolicy } from '../../src/core/policy.js';
import { parameterizeValue, substituteTemplate } from '../../src/core/template.js';
import { buildExampleMemberBalanceArtifact } from '../../src/examples.js';

describe('artifact schema and helpers', () => {
  it('accepts the example artifact and verifies checksum', async () => {
    const artifact = buildExampleMemberBalanceArtifact('http://127.0.0.1:3000');
    expect(capabilityArtifactSchema.parse(artifact).capabilityId).toBe('member-balance-lookup');
    expect(verifyArtifactChecksum(artifact)).toBe(true);

    const tempDir = await mkdtemp(join(os.tmpdir(), 'artifact-'));
    const artifactPath = join(tempDir, 'artifact.json');
    await writeFile(artifactPath, JSON.stringify(artifact, null, 2));
    expect(artifact.integrity.algorithm).toBe('sha256');
  });

  it('rejects an unsupported schema version', () => {
    const artifact = buildExampleMemberBalanceArtifact('http://127.0.0.1:3000');
    expect(() => capabilityArtifactSchema.parse({ ...artifact, schemaVersion: '0.9.0' })).toThrow();
  });

  it('parameterizes and substitutes runtime inputs', () => {
    expect(parameterizeValue('member 12345', { memberId: '12345' })).toBe('member {{memberId}}');
    expect(substituteTemplate('member {{memberId}}', { memberId: '12345' })).toBe('member 12345');
  });
});

describe('policy and redaction', () => {
  it('allows safe navigation and blocks unsafe routes', () => {
    const policy = createDefaultPolicy();
    expect(
      evaluatePolicy(policy, { type: 'navigate', url: 'http://127.0.0.1:3000/', rationale: 'safe' }, 'http://127.0.0.1:3000')
    ).toMatchObject({ allowed: true });
    expect(
      evaluatePolicy(policy, { type: 'navigate', url: 'https://example.com/', rationale: 'unsafe' }, 'http://127.0.0.1:3000')
    ).toMatchObject({ allowed: false });
  });

  it('blocks sensitive fields and irreversible clicks without approval', () => {
    const policy = createDefaultPolicy();
    expect(
      evaluatePolicy(
        policy,
        { type: 'type', value: 'secret', sensitive: true, rationale: 'blocked', target: { name: 'Password', description: 'pw', stableReason: 'pw', risk: 'sensitive', priority: [{ kind: 'css', css: '#pw' }] } },
        'http://127.0.0.1:3000',
        'Password'
      )
    ).toMatchObject({ allowed: false, risk: 'sensitive' });
    expect(
      evaluatePolicy(
        policy,
        { type: 'click', rationale: 'blocked', target: { name: 'Confirm Submission', description: 'confirm', stableReason: 'confirm', risk: 'irreversible', priority: [{ kind: 'text', text: 'Confirm Submission' }] } },
        'http://127.0.0.1:3000',
        'Confirm Submission'
      )
    ).toMatchObject({ allowed: false, risk: 'irreversible' });
  });

  it('redacts secrets and sensitive field values', () => {
    expect(redactText('Authorization: bearer abc123')).toContain('[REDACTED]');
    expect(redactFieldValue('password', 'hunter2')).toBe('[REDACTED]');
    expect(sanitizeObject({ token: 'abc123', note: 'safe' })).toEqual({ token: '[REDACTED]', note: 'safe' });
  });
});
