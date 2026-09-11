import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  artifactPayloadForChecksum,
  computeArtifactChecksum,
} from '../../src/core/checksum.js';
import { createDefaultPolicy } from '../../src/core/defaults.js';
import {
  buildExampleMemberBalanceArtifact,
  buildOpenSubAccountArtifact,
} from '../../src/examples.js';
import { runReplay } from '../../src/replay.js';
import { HandoffManager } from '../../src/runtime/handoff.js';
import { createTargetServer } from '../../src/target/server.js';

const defaultTargetUrl = 'http://127.0.0.1:3000';

describe('deterministic replay integration', () => {
  const targetServer = createTargetServer(3000);
  let tempDir: string;
  let memberArtifactPath: string;
  let openArtifactPath: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(os.tmpdir(), 'computer-use-tests-'));
    memberArtifactPath = join(tempDir, 'member-balance.v1.json');
    openArtifactPath = join(tempDir, 'open-sub-account-review.v1.json');
    await writeFile(
      memberArtifactPath,
      JSON.stringify(
        buildExampleMemberBalanceArtifact(defaultTargetUrl),
        null,
        2
      )
    );
    await writeFile(
      openArtifactPath,
      JSON.stringify(buildOpenSubAccountArtifact(defaultTargetUrl), null, 2)
    );
    await targetServer.start();
  });

  afterAll(async () => {
    await targetServer.stop();
  });

  it('replays successfully without an LLM provider', async () => {
    const sentinelProvider = { nextAction: vi.fn() };
    const result = await runReplay({
      artifactPath: memberArtifactPath,
      inputs: { memberId: '12345' },
      targetUrl: defaultTargetUrl,
      policy: createDefaultPolicy(),
      evidenceBaseDir: join(tempDir, 'replay-success'),
    });

    expect(result.status).toBe('success');
    expect(
      result.status === 'success' ? result.outputs.savingsBalance : ''
    ).toBe('$1,234.56');
    expect(sentinelProvider.nextAction).not.toHaveBeenCalled();
  });

  it('returns member-not-found as a business outcome', async () => {
    const result = await runReplay({
      artifactPath: memberArtifactPath,
      inputs: { memberId: '99999' },
      targetUrl: `${defaultTargetUrl}?scenario=member-not-found`,
      policy: createDefaultPolicy(),
      evidenceBaseDir: join(tempDir, 'replay-business-outcome'),
    });

    expect(result).toMatchObject({
      status: 'business_outcome',
      code: 'MEMBER_NOT_FOUND',
    });
  });

  for (const [scenario, category] of [
    ['validation-error', 'Validation error'],
    ['permission-denied', 'Permission denial'],
    ['session-expired', 'Session expiration'],
    ['application-error', 'Application error'],
    ['unexpected-dialog', 'Unexpected dialog'],
  ] as const) {
    it(`classifies ${scenario} as ${category}`, async () => {
      const result = await runReplay({
        artifactPath: memberArtifactPath,
        inputs: { memberId: '12345' },
        targetUrl: `${defaultTargetUrl}?scenario=${scenario}`,
        policy: createDefaultPolicy(),
        evidenceBaseDir: join(tempDir, `scenario-${scenario}`),
      });
      expect(result.status).toBe('failure');
      if (result.status === 'failure') {
        expect(result.category).toBe(category);
      }
    });
  }

  it('uses bounded retry for slow-load recovery', async () => {
    const result = await runReplay({
      artifactPath: memberArtifactPath,
      inputs: { memberId: '12345' },
      targetUrl: `${defaultTargetUrl}?scenario=slow-load`,
      policy: createDefaultPolicy(),
      evidenceBaseDir: join(tempDir, 'slow-load'),
    });

    expect(result.status).toBe('success');
  });

  it('fails checkpoint verification when artifact expectations drift', async () => {
    const driftedArtifactPath = join(tempDir, 'drifted-artifact.json');
    const drifted = buildExampleMemberBalanceArtifact(defaultTargetUrl);
    drifted.steps[3]!.expectedPageState.textIncludes = 'Definitely Not Present';
    drifted.integrity.checksum = computeArtifactChecksum(
      artifactPayloadForChecksum(drifted)
    );
    await writeFile(driftedArtifactPath, JSON.stringify(drifted, null, 2));

    const result = await runReplay({
      artifactPath: driftedArtifactPath,
      inputs: { memberId: '12345' },
      targetUrl: defaultTargetUrl,
      policy: createDefaultPolicy(),
      evidenceBaseDir: join(tempDir, 'drifted'),
    });
    expect(result).toMatchObject({
      status: 'failure',
      category: 'Checkpoint failure',
    });
  });

  it('blocks irreversible replay steps when no human approval path is provided', async () => {
    const result = await runReplay({
      artifactPath: openArtifactPath,
      inputs: { memberId: '12345' },
      targetUrl: defaultTargetUrl,
      policy: createDefaultPolicy(),
      evidenceBaseDir: join(tempDir, 'irreversible-blocked'),
    });

    expect(result).toMatchObject({
      status: 'failure',
      category: 'Policy violation',
    });
  });

  it('pauses, keeps the same browser context, records audit events, and resumes', async () => {
    const manager = new HandoffManager();
    let sameContext = false;
    const result = await runReplay({
      artifactPath: openArtifactPath,
      inputs: { memberId: '12345' },
      targetUrl: defaultTargetUrl,
      policy: createDefaultPolicy(),
      evidenceBaseDir: join(tempDir, 'handoff'),
      handoffManager: manager,
      onInterventionRequested: async ({ interventionId, context, page }) => {
        sameContext = context === page.context();
        const frame = page.frame({ name: 'legacy-app-frame' });
        await frame
          ?.getByRole('button', { name: 'Confirm Submission' })
          .click();
        manager.recordAudit(interventionId, {
          type: 'click',
          at: frame?.url() ?? page.url(),
          source: 'simulated-operator',
        });
        manager.resolve(
          interventionId,
          'resume',
          manager.get(interventionId).leaseToken
        );
      },
    });

    expect(sameContext).toBe(true);
    expect(result.status).toBe('success');
    expect(
      manager.list()[0]?.auditEvents.some((event) => event.type === 'click')
    ).toBe(true);
  }, 10_000);
});
