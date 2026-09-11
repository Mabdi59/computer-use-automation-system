import { randomUUID } from 'node:crypto';

import express from 'express';

import { sanitizeObject } from '../core/redaction.js';

export type RunControlState =
  'AUTOMATION' | 'HUMAN_REQUESTED' | 'HUMAN_CONTROL' | 'RESUMING' | 'COMPLETED';

export type InterventionRequest = {
  interventionId: string;
  runId: string;
  goal: string;
  currentStep?: string;
  reason: string;
  screenshotPath?: string;
  observation: Record<string, unknown>;
  evidenceLinks: string[];
  leaseToken?: string;
  state: RunControlState;
  awaitingExternalResolution?: boolean;
  auditEvents: Array<Record<string, unknown>>;
};

export class HandoffManager {
  private readonly operatorAccessToken = randomUUID();
  private readonly interventions = new Map<string, InterventionRequest>();
  private readonly waiters = new Map<
    string,
    (decision: 'resume' | 'abort') => void
  >();
  private readonly decisions = new Map<string, 'resume' | 'abort'>();

  createRouter(): express.Router {
    const router = express.Router();
    const operatorToken = this.operatorAccessToken;
    const authorize: express.RequestHandler = (request, response, next) => {
      const queryToken = request.query.operatorToken;
      const providedToken =
        typeof queryToken === 'string' && queryToken.length > 0
          ? queryToken
          : String(request.get('x-operator-token') ?? '');
      if (providedToken !== operatorToken) {
        response.status(403).send('Operator token required.');
        return;
      }
      next();
    };
    router.use(authorize);
    router.get('/operator', (_request, response) => {
      response.type('html').send(`<!doctype html>
<html><body><h1>Operator Console</h1><main aria-label="Active interventions"><div id="app" role="status" aria-live="polite"></div></main>
<script>
const operatorToken = ${JSON.stringify(operatorToken)};
const render = (item) => {
  const section = document.createElement('section');
  section.style.border = '1px solid #999';
  section.style.margin = '8px';
  section.style.padding = '8px';
  const heading = document.createElement('h2');
  heading.textContent = item.interventionId;
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(item, null, 2);
  const claimButton = document.createElement('button');
  claimButton.textContent = 'Claim';
  claimButton.setAttribute('aria-label', 'Claim intervention ' + item.interventionId);
  claimButton.onclick = () => claim(item.interventionId);
  const resumeButton = document.createElement('button');
  resumeButton.textContent = 'Resume';
  resumeButton.setAttribute('aria-label', 'Resume intervention ' + item.interventionId);
  resumeButton.onclick = () => resumeIntervention(item.interventionId, item.leaseToken);
  const abortButton = document.createElement('button');
  abortButton.textContent = 'Abort';
  abortButton.setAttribute('aria-label', 'Abort intervention ' + item.interventionId);
  abortButton.onclick = () => abortRun(item.interventionId, item.leaseToken);
  section.append(heading, pre, claimButton, resumeButton, abortButton);
  return section;
};
async function refresh(){
 const res = await fetch('/operator/api/interventions?operatorToken=' + encodeURIComponent(operatorToken));
 const items = await res.json();
 const root = document.getElementById('app');
 root.replaceChildren(...items.map(render));
}
async function claim(id){ await fetch('/operator/api/interventions/' + id + '/claim?operatorToken=' + encodeURIComponent(operatorToken), {method:'POST'}); await refresh(); }
async function resumeIntervention(id, leaseToken){ await fetch('/operator/api/interventions/' + id + '/resolve?operatorToken=' + encodeURIComponent(operatorToken) + '&leaseToken=' + encodeURIComponent(leaseToken || ''), {method:'POST'}); await refresh(); }
async function abortRun(id, leaseToken){ await fetch('/operator/api/interventions/' + id + '/abort?operatorToken=' + encodeURIComponent(operatorToken) + '&leaseToken=' + encodeURIComponent(leaseToken || ''), {method:'POST'}); await refresh(); }
refresh(); setInterval(refresh, 1000);
</script></body></html>`);
    });
    router.get('/operator/api/interventions', (_request, response) => {
      response.json(Array.from(this.interventions.values()));
    });
    router.post(
      '/operator/api/interventions/:id/claim',
      (request, response) => {
        response.json(this.claim(request.params.id));
      }
    );
    router.post(
      '/operator/api/interventions/:id/resolve',
      (request, response) => {
        try {
          this.resolve(
            request.params.id,
            'resume',
            String(request.query.leaseToken ?? '')
          );
          response.json({ ok: true });
        } catch (error) {
          response
            .status(403)
            .json({ ok: false, error: (error as Error).message });
        }
      }
    );
    router.post(
      '/operator/api/interventions/:id/abort',
      (request, response) => {
        try {
          this.resolve(
            request.params.id,
            'abort',
            String(request.query.leaseToken ?? '')
          );
          response.json({ ok: true });
        } catch (error) {
          response
            .status(403)
            .json({ ok: false, error: (error as Error).message });
        }
      }
    );
    return router;
  }

  async requestIntervention(
    input: Omit<InterventionRequest, 'interventionId' | 'state' | 'auditEvents'>
  ): Promise<InterventionRequest> {
    const interventionId = randomUUID();
    const intervention: InterventionRequest = {
      interventionId,
      state: 'HUMAN_REQUESTED',
      auditEvents: [],
      ...input,
      observation: sanitizeObject(input.observation),
    };
    this.interventions.set(interventionId, intervention);
    return intervention;
  }

  waitForResolution(interventionId: string): Promise<'resume' | 'abort'> {
    const settled = this.decisions.get(interventionId);
    if (settled) {
      return Promise.resolve(settled);
    }
    return new Promise((resolve) => {
      this.waiters.set(interventionId, resolve);
    });
  }

  claim(interventionId: string): InterventionRequest {
    const intervention = this.get(interventionId);
    if (!intervention.leaseToken) {
      intervention.leaseToken = randomUUID();
      intervention.state = 'HUMAN_CONTROL';
    }
    return intervention;
  }

  recordAudit(interventionId: string, event: Record<string, unknown>): void {
    const intervention = this.get(interventionId);
    intervention.auditEvents.push(sanitizeObject(event));
  }

  resolve(
    interventionId: string,
    decision: 'resume' | 'abort',
    leaseToken?: string
  ): void {
    const intervention = this.get(interventionId);
    if (intervention.leaseToken && intervention.leaseToken !== leaseToken) {
      throw new Error(
        `Lease token mismatch for intervention ${interventionId}`
      );
    }
    intervention.state = decision === 'resume' ? 'RESUMING' : 'COMPLETED';
    this.decisions.set(interventionId, decision);
    const waiter = this.waiters.get(interventionId);
    if (typeof waiter === 'function') {
      waiter(decision);
    }
    this.waiters.delete(interventionId);
    if (decision === 'abort') {
      intervention.state = 'COMPLETED';
    }
  }

  complete(interventionId: string): void {
    this.get(interventionId).state = 'COMPLETED';
    this.decisions.delete(interventionId);
  }

  markAwaitingExternalResolution(interventionId: string): void {
    this.get(interventionId).awaitingExternalResolution = true;
  }

  get(interventionId: string): InterventionRequest {
    const intervention = this.interventions.get(interventionId);
    if (!intervention) {
      throw new Error(`Unknown intervention ${interventionId}`);
    }
    return intervention;
  }

  list(): InterventionRequest[] {
    return Array.from(this.interventions.values());
  }

  getOperatorAccessToken(): string {
    return this.operatorAccessToken;
  }
}
