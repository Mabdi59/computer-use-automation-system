import type { LLMAction, PolicyConfig } from './schemas.js';

const sensitivePatternFromConfig = (policy: PolicyConfig): RegExp =>
  new RegExp(policy.sensitiveFieldPatterns.join('|'), 'i');

export type PolicyDecision = {
  allowed: boolean;
  reason: string;
  risk: 'safe' | 'sensitive' | 'irreversible';
};

const getDefaultPort = (protocol: string): number =>
  protocol === 'https:' ? 443 : 80;

export const evaluatePolicy = (
  policy: PolicyConfig,
  action: LLMAction,
  currentUrl: string,
  targetName?: string
): PolicyDecision => {
  if (!policy.allowedActionTypes.includes(action.type)) {
    return {
      allowed: false,
      reason: `Action ${action.type} is not allowlisted`,
      risk: 'safe',
    };
  }

  if (action.type === 'navigate') {
    const url = new URL(action.url ?? action.route ?? currentUrl, currentUrl);
    if (!policy.allowedProtocols.includes(url.protocol.replace(':', ''))) {
      return {
        allowed: false,
        reason: `Protocol ${url.protocol} is blocked`,
        risk: 'safe',
      };
    }
    if (
      !policy.allowedHosts.includes(url.hostname) ||
      !policy.allowedPorts.includes(
        Number(url.port || getDefaultPort(url.protocol))
      )
    ) {
      return {
        allowed: false,
        reason: `Destination ${url.host} is outside the allowlist`,
        risk: 'safe',
      };
    }
    if (!policy.allowedRoutes.some((route) => url.pathname.startsWith(route))) {
      return {
        allowed: false,
        reason: `Route ${url.pathname} is outside the allowlist`,
        risk: 'safe',
      };
    }
  }

  if (action.type === 'type') {
    const sensitive =
      sensitivePatternFromConfig(policy).test(targetName ?? '') ||
      action.sensitive;
    if (sensitive && !policy.allowSensitiveInput) {
      return {
        allowed: false,
        reason: `Sensitive field ${targetName ?? 'unknown'} is blocked`,
        risk: 'sensitive',
      };
    }
    return {
      allowed: true,
      reason: 'Typing action allowed',
      risk: sensitive ? 'sensitive' : 'safe',
    };
  }

  const irreversible =
    action.type === 'click' &&
    /confirm|submit|finalize|approve/i.test(targetName ?? '');
  if (irreversible) {
    if (policy.allowIrreversibleActions) {
      return {
        allowed: true,
        reason: 'Irreversible action explicitly allowed',
        risk: 'irreversible',
      };
    }
    if (policy.requireHumanApprovalForIrreversible) {
      return {
        allowed: false,
        reason: 'Irreversible action requires human approval',
        risk: 'irreversible',
      };
    }
    return {
      allowed: false,
      reason: 'Irreversible action blocked',
      risk: 'irreversible',
    };
  }

  return { allowed: true, reason: 'Action allowed by policy', risk: 'safe' };
};
