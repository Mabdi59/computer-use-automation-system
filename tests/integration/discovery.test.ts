import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDefaultPolicy } from '../../src/core/defaults.js';
import { runDiscovery } from '../../src/discovery.js';
import { ScriptedLLMProvider } from '../../src/providers/llm.js';
import { HandoffManager } from '../../src/runtime/handoff.js';
import { createTargetServer } from '../../src/target/server.js';

const discoveryPort = 3001;
const defaultTargetUrl = `http://127.0.0.1:${discoveryPort}`;

describe('discovery handoff integration', () => {
  const targetServer = createTargetServer(discoveryPort);
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(os.tmpdir(), 'computer-use-discovery-'));
    await targetServer.start();
  });

  afterAll(async () => {
    await targetServer.stop();
  });

  it('passes the live browser context and page to handoff callbacks', async () => {
    const manager = new HandoffManager();
    let sameContext = false;
    let preservedCookie = false;
    const policy = createDefaultPolicy();
    policy.allowedPorts = [discoveryPort];
    policy.allowedFrameOrigins = [defaultTargetUrl];

    const result = await runDiscovery({
      goal: 'Pause discovery for a synthetic operator review',
      targetUrl: defaultTargetUrl,
      provider: new ScriptedLLMProvider([
        {
          type: 'navigate',
          url: `${defaultTargetUrl}/`,
          rationale: 'Open the synthetic shell.',
        },
        {
          type: 'escalate',
          reason: 'Need human confirmation before continuing.',
          rationale: 'Pause for a synthetic operator.',
        },
        {
          type: 'finish',
          status: 'success',
          reason: 'Discovery completed after human review.',
          rationale: 'Stop after the handoff.',
        },
      ]),
      policy,
      evidenceBaseDir: join(tempDir, 'discovery-handoff'),
      artifactPath: join(tempDir, 'discovery-handoff-artifact.json'),
      handoffManager: manager,
      onInterventionRequested: async ({
        intervention,
        browserContext,
        page,
      }) => {
        sameContext = browserContext === page.context();
        preservedCookie = (await browserContext.cookies()).some(
          (cookie) =>
            cookie.name === 'syntheticSession' &&
            cookie.value === 'synthetic-session-active'
        );
        manager.resolve(
          intervention.interventionId,
          'resume',
          manager.get(intervention.interventionId).leaseToken
        );
      },
    });

    expect(sameContext).toBe(true);
    expect(preservedCookie).toBe(true);
    expect(result.status).toBe('success');
  });
});
