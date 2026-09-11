import OpenAI from 'openai';

import { redactText } from '../core/redaction.js';
import { llmActionSchema, type LLMAction, type Observation } from '../core/schemas.js';

export type LLMRequest = {
  goal: string;
  observation: Observation;
  previousActions: LLMAction[];
};

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  nextAction(request: LLMRequest): Promise<LLMAction>;
}

export class OpenAILLMProvider implements LLMProvider {
  readonly name = 'openai';
  readonly model: string;
  private readonly client: OpenAI;

  constructor(apiKey: string, model = process.env.OPENAI_MODEL ?? 'gpt-5-mini') {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async nextAction(request: LLMRequest): Promise<LLMAction> {
    const response = await this.client.responses.create({
      model: this.model,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text:
                'You operate a browser safely. Return one JSON action matching the provided schema. Include only a short operational rationale, never hidden reasoning.',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: redactText(
                JSON.stringify({
                  goal: request.goal,
                  observation: request.observation,
                  previousActions: request.previousActions,
                  requiredActions: [
                    'navigate',
                    'click',
                    'type',
                    'select',
                    'wait',
                    'extract',
                    'assert',
                    'finish',
                    'escalate',
                  ],
                })
              ),
            },
          ],
        },
      ],
    });

    const text = response.output_text;
    return llmActionSchema.parse(JSON.parse(text));
  }
}

export class ScriptedLLMProvider implements LLMProvider {
  readonly name = 'scripted';
  readonly model = 'scripted-test';
  private cursor = 0;

  constructor(private readonly actions: LLMAction[]) {}

  async nextAction(): Promise<LLMAction> {
    const action = this.actions[this.cursor];
    if (!action) {
      throw new Error('Scripted provider exhausted');
    }
    this.cursor += 1;
    return llmActionSchema.parse(action);
  }
}

export const scriptedMemberBalancePlan = (baseUrl: string, memberId: string): LLMAction[] => [
  {
    type: 'navigate',
    url: `${baseUrl}/`,
    rationale: 'Open the target application shell.',
  },
  {
    type: 'click',
    target: {
      name: 'Member Search link',
      description: 'Navigates from the legacy home page to member search',
      stableReason: 'Stable legacy navigation text inside the shell frame.',
      risk: 'safe',
      priority: [
        { kind: 'text', text: 'Member Search', frameName: 'legacy-app-frame' },
        { kind: 'role', role: 'link', name: 'Member Search', frameName: 'legacy-app-frame' },
      ],
    },
    rationale: 'Open the member search page.',
  },
  {
    type: 'type',
    target: {
      name: 'Member ID input',
      description: 'Synthetic member id textbox on legacy search form',
      stableReason: 'The visible legacy label is stable across variants.',
      risk: 'safe',
      priority: [
        { kind: 'label', label: 'Member ID', frameName: 'legacy-app-frame' },
        { kind: 'css', css: 'input[name="memberId"]', frameName: 'legacy-app-frame' },
      ],
    },
    value: memberId,
    sensitive: false,
    rationale: 'Enter the synthetic member id.',
  },
  {
    type: 'click',
    target: {
      name: 'Search member button',
      description: 'Submits the member search form in the legacy frame',
      stableReason: 'The button text is a stable verb in the product flow.',
      risk: 'safe',
      priority: [
        { kind: 'role', role: 'button', name: 'Search Member', frameName: 'legacy-app-frame' },
        { kind: 'text', text: 'Search Member', frameName: 'legacy-app-frame' },
      ],
    },
    rationale: 'Search for the synthetic member.',
  },
  {
    type: 'assert',
    target: {
      name: 'Savings balance label',
      description: 'Savings balance table row label',
      stableReason: 'This product label is stable and readable in the member details page.',
      risk: 'safe',
      priority: [
        { kind: 'text', text: 'Savings Balance', frameName: 'legacy-app-frame' },
        { kind: 'css', css: 'td.balance-label', frameName: 'legacy-app-frame' },
      ],
    },
    condition: 'containsText',
    expected: 'Savings Balance',
    rationale: 'Verify the member details page loaded.',
  },
  {
    type: 'extract',
    target: {
      name: 'Savings balance value',
      description: 'Savings balance value cell',
      stableReason: 'The row is anchored by a stable visible label with a scoped CSS fallback.',
      risk: 'safe',
      priority: [
        { kind: 'css', css: '#savings-balance', frameName: 'legacy-app-frame' },
        { kind: 'text', text: '$1,234.56', frameName: 'legacy-app-frame' },
      ],
    },
    outputKey: 'savingsBalance',
    rationale: 'Capture the savings balance output.',
  },
  {
    type: 'finish',
    status: 'success',
    reason: 'Savings balance captured from the legacy member details page.',
    rationale: 'Discovery succeeded.',
  },
];
