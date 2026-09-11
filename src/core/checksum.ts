import { createHash } from 'node:crypto';

import type { CapabilityArtifact } from './schemas.js';

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

export const artifactPayloadForChecksum = (artifact: CapabilityArtifact): Omit<CapabilityArtifact, 'integrity'> => {
  const { integrity: _integrity, ...payload } = artifact;
  return payload;
};

export const computeArtifactChecksum = (artifact: CapabilityArtifact | Omit<CapabilityArtifact, 'integrity'>): string =>
  createHash('sha256').update(stableStringify(artifact)).digest('hex');

export const verifyArtifactChecksum = (artifact: CapabilityArtifact): boolean =>
  computeArtifactChecksum(artifactPayloadForChecksum(artifact)) === artifact.integrity.checksum;
