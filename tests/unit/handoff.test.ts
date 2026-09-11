import { once } from 'node:events';
import { createServer, type Server } from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { HandoffManager } from '../../src/runtime/handoff.js';

describe('handoff operator authorization', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error?: Error) =>
              error ? reject(error) : resolve()
            );
          })
      )
    );
  });

  it('accepts the operator token from the header when no query token is present', async () => {
    const manager = new HandoffManager();
    const app = express();
    app.use(manager.createRouter());
    const server = createServer(app);
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server address unavailable');
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/operator/api/interventions`,
      {
        headers: {
          'x-operator-token': manager.getOperatorAccessToken(),
        },
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });
});
