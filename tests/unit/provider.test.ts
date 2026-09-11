import { describe, expect, it, vi } from 'vitest';

import { OpenAILLMProvider } from '../../src/providers/llm.js';

describe('OpenAI provider integration contract', () => {
  it('redacts sensitive observation content and parses wrapped JSON actions', async () => {
    const provider = new OpenAILLMProvider('test-key', 'test-model');
    const create = vi.fn().mockResolvedValue({
      output_text:
        'Operational note:\n{"type":"wait","ms":250,"rationale":"wait for the next synthetic page state"}',
    });
    (provider as unknown as { client: { responses: { create: typeof create } } }).client =
      { responses: { create } };

    const action = await provider.nextAction({
      goal: 'Look up member 12345 and return the current savings balance',
      observation: {
        url: 'http://127.0.0.1:3000',
        title: 'Synthetic Legacy App',
        visibleText: 'Authorization: bearer abc123',
        elementSummary: ['textbox Member ID'],
        frames: [],
        dialogs: [],
      },
      previousActions: [],
    });

    expect(action).toMatchObject({
      type: 'wait',
      ms: 250,
    });
    const requestText = create.mock.calls[0]?.[0]?.input?.[1]?.content?.[0]?.text;
    expect(requestText).toContain('[REDACTED]');
    expect(requestText).not.toContain('abc123');
  });
});
