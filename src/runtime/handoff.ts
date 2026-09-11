import { randomUUID } from 'node:crypto';

import express from 'express';

import { sanitizeObject } from '../core/redaction.js';

export type RunControlState = 'AUTOMATION' | 'HUMAN_REQUESTED' | 'HUMAN_CONTROL' | 'RESUMING' | 'COMPLETED';

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
  auditEvents: Array<Record<string, unknown>>;
};

export class HandoffManager {
  private readonly interventions = new Map<string, InterventionRequest>();
  private readonly waiters = new Map<string, (decision: 'resume' | 'abort') => void>();
  private readonly decisions = new Map<string, 'resume' | 'abort'>();

  createRouter(): express.Router {
    const router = express.Router();
    router.get('/operator', (_request, response) => {
      response.type('html').send(`<!doctype html>
<html><body><h1>Operator Console</h1><div id="app"></div>
<script>
const render = (item) => '<section style="border:1px solid #999;margin:8px;padding:8px">' +
  '<h2>' + item.interventionId + '</h2>' +
  '<pre>' + JSON.stringify(item, null, 2) + '</pre>' +
  '<button onclick="claim(\\'' + item.interventionId + '\\')">Claim</button>' +
  '<button onclick="resumeIntervention(\\'' + item.interventionId + '\\')">Resume</button>' +
  '<button onclick="abortRun(\\'' + item.interventionId + '\\')">Abort</button>' +
  '</section>';
async function refresh(){
 const res = await fetch('/operator/api/interventions');
 const items = await res.json();
 document.getElementById('app').innerHTML = items.map(render).join('');
}
async function claim(id){ await fetch('/operator/api/interventions/' + id + '/claim', {method:'POST'}); await refresh(); }
async function resumeIntervention(id){ await fetch('/operator/api/interventions/' + id + '/resolve', {method:'POST'}); await refresh(); }
async function abortRun(id){ await fetch('/operator/api/interventions/' + id + '/abort', {method:'POST'}); await refresh(); }
refresh(); setInterval(refresh, 1000);
</script></body></html>`);
    });
    router.get('/operator/api/interventions', (_request, response) => {
      response.json(Array.from(this.interventions.values()));
    });
    router.post('/operator/api/interventions/:id/claim', (request, response) => {
      response.json(this.claim(request.params.id));
    });
    router.post('/operator/api/interventions/:id/resolve', (request, response) => {
      this.resolve(request.params.id, 'resume');
      response.json({ ok: true });
    });
    router.post('/operator/api/interventions/:id/abort', (request, response) => {
      this.resolve(request.params.id, 'abort');
      response.json({ ok: true });
    });
    return router;
  }

  async requestIntervention(input: Omit<InterventionRequest, 'interventionId' | 'state' | 'auditEvents'>): Promise<InterventionRequest> {
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

  resolve(interventionId: string, decision: 'resume' | 'abort'): void {
    const intervention = this.get(interventionId);
    intervention.state = decision === 'resume' ? 'RESUMING' : 'COMPLETED';
    this.decisions.set(interventionId, decision);
    this.waiters.get(interventionId)?.(decision);
    this.waiters.delete(interventionId);
    if (decision === 'abort') {
      intervention.state = 'COMPLETED';
    }
  }

  complete(interventionId: string): void {
    this.get(interventionId).state = 'COMPLETED';
    this.decisions.delete(interventionId);
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
}
