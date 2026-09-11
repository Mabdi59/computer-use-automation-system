import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createDefaultPolicy } from './core/defaults.js';
import { runDiscovery } from './discovery.js';
import { buildOpenSubAccountArtifact } from './examples.js';
import {
  OpenAILLMProvider,
  ScriptedLLMProvider,
  scriptedMemberBalancePlan,
} from './providers/llm.js';
import { runReplay } from './replay.js';
import { HandoffManager } from './runtime/handoff.js';
import { createTargetServer } from './target/server.js';

const repoRoot = process.cwd();
const defaultTargetUrl = 'http://127.0.0.1:3000';

const parseArgs = (argv: string[]): Record<string, string | boolean> => {
  const result: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
};

const parseInputs = (value?: string): Record<string, string> => {
  if (!value) {
    return {};
  }
  return Object.fromEntries(
    value
      .split(',')
      .filter(Boolean)
      .map((entry) => entry.split('=').map((part) => part.trim()))
      .map(([key, entryValue]) => [key, entryValue])
  );
};

const ensureLiveEvidenceInstructions = async (): Promise<void> => {
  await mkdir(resolve(repoRoot, 'evidence'), { recursive: true });
  await writeFile(
    resolve(repoRoot, 'evidence/README.md'),
    `# Evidence\n\nThis repository includes offline scripted evidence marked \`mode: scripted-test\`.\n\nTo generate genuine live discovery evidence after setting OPENAI_API_KEY, run:\n\n\`\`\`bash\nnpm install\nnpx playwright install chromium\nnpm run dev:target\nnpm run evidence:live\n\`\`\`\n\nThe live command runs discovery against http://127.0.0.1:3000 and writes fresh evidence into /evidence/discovery/. Do not submit fabricated live evidence.\n`
  );
};

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));

const main = async (): Promise<void> => {
  await ensureLiveEvidenceInstructions();
  switch (command) {
    case 'dev:target': {
      const handoffManager = new HandoffManager();
      const targetServer = createTargetServer(Number(args.port ?? 3000));
      targetServer.app.use(handoffManager.createRouter());
      await targetServer.start();
      console.log(
        `Synthetic target app running on http://127.0.0.1:${targetServer.port}`
      );
      console.log(
        `Operator console: http://127.0.0.1:${targetServer.port}/operator?operatorToken=${handoffManager.getOperatorAccessToken()}`
      );
      return new Promise(() => undefined);
    }
    case 'discover': {
      const targetUrl = String(args.target ?? defaultTargetUrl);
      const goal = String(
        args.goal ??
          'Look up member 12345 and return the current savings balance'
      );
      const artifactPath = resolve(
        repoRoot,
        String(args.artifact ?? 'artifacts/member-balance.v1.json')
      );
      const provider =
        process.env.OPENAI_API_KEY && !args.scripted
          ? new OpenAILLMProvider(process.env.OPENAI_API_KEY)
          : new ScriptedLLMProvider(
              scriptedMemberBalancePlan(
                targetUrl,
                parseInputs(String(args.input ?? 'memberId=12345')).memberId ??
                  '12345'
              )
            );
      const result = await runDiscovery({
        goal,
        targetUrl,
        provider,
        policy: createDefaultPolicy(),
        evidenceBaseDir: resolve(repoRoot, 'evidence/discovery'),
        artifactPath,
        headed: Boolean(args.headed),
        inputHints: parseInputs(String(args.input ?? 'memberId=12345')),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'replay': {
      const artifactPath = resolve(
        repoRoot,
        String(args.artifact ?? 'artifacts/member-balance.v1.json')
      );
      const result = await runReplay({
        artifactPath,
        inputs: parseInputs(String(args.input ?? 'memberId=12345')),
        targetUrl: String(args.target ?? defaultTargetUrl),
        policy: createDefaultPolicy(),
        evidenceBaseDir: resolve(repoRoot, 'evidence/replay-success'),
        headed: Boolean(args.headed),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'demo': {
      const handoffManager = new HandoffManager();
      const targetServer = createTargetServer(3000);
      targetServer.app.use(handoffManager.createRouter());
      await targetServer.start();
      console.log('Demo target started at http://127.0.0.1:3000');
      try {
        const memberArtifactPath = resolve(
          repoRoot,
          'artifacts/member-balance.v1.json'
        );
        const discoverResult = await runDiscovery({
          goal: 'Look up member 12345 and return the current savings balance',
          targetUrl: defaultTargetUrl,
          provider: new ScriptedLLMProvider(
            scriptedMemberBalancePlan(defaultTargetUrl, '12345')
          ),
          policy: createDefaultPolicy(),
          evidenceBaseDir: resolve(repoRoot, 'evidence/discovery'),
          artifactPath: memberArtifactPath,
          headed: Boolean(args.headed),
          inputHints: { memberId: '12345' },
        });
        console.log('Discovery:', JSON.stringify(discoverResult, null, 2));
        const replaySuccess = await runReplay({
          artifactPath: memberArtifactPath,
          inputs: { memberId: '12345' },
          targetUrl: defaultTargetUrl,
          policy: createDefaultPolicy(),
          evidenceBaseDir: resolve(repoRoot, 'evidence/replay-success'),
          headed: Boolean(args.headed),
        });
        console.log('Replay success:', JSON.stringify(replaySuccess, null, 2));
        const replayOutcome = await runReplay({
          artifactPath: memberArtifactPath,
          inputs: { memberId: '99999' },
          targetUrl: `${defaultTargetUrl}?scenario=member-not-found`,
          policy: createDefaultPolicy(),
          evidenceBaseDir: resolve(
            repoRoot,
            'evidence/replay-business-outcome'
          ),
        });
        console.log(
          'Replay business outcome:',
          JSON.stringify(replayOutcome, null, 2)
        );
        const openArtifactPath = resolve(
          repoRoot,
          'artifacts/open-sub-account-review.v1.json'
        );
        await writeFile(
          openArtifactPath,
          JSON.stringify(buildOpenSubAccountArtifact(defaultTargetUrl), null, 2)
        );
        if (args.headed) {
          console.log(
            `Operator console available at http://127.0.0.1:3000/operator?operatorToken=${handoffManager.getOperatorAccessToken()}`
          );
          console.log(
            'When the headed browser reaches the review page, claim and resume the intervention after manual inspection.'
          );
          const handoffResult = await runReplay({
            artifactPath: openArtifactPath,
            inputs: { memberId: '12345' },
            targetUrl: defaultTargetUrl,
            policy: createDefaultPolicy(),
            evidenceBaseDir: resolve(repoRoot, 'evidence/handoff'),
            headed: true,
            handoffManager,
          });
          console.log(
            'Replay handoff:',
            JSON.stringify(handoffResult, null, 2)
          );
        }
      } finally {
        await targetServer.stop();
      }
      return;
    }
    case 'evidence:live': {
      if (!process.env.OPENAI_API_KEY) {
        console.error(
          'OPENAI_API_KEY is not set. After exporting it, run: npm run discover -- --goal "Look up member 12345 and return the current savings balance" --target http://127.0.0.1:3000 --artifact artifacts/member-balance.live.v1.json --input memberId=12345'
        );
        process.exitCode = 1;
        return;
      }
      const targetServer = createTargetServer(3000);
      await targetServer.start();
      try {
        const result = await runDiscovery({
          goal: 'Look up member 12345 and return the current savings balance',
          targetUrl: defaultTargetUrl,
          provider: new OpenAILLMProvider(process.env.OPENAI_API_KEY),
          policy: createDefaultPolicy(),
          evidenceBaseDir: resolve(repoRoot, 'evidence/discovery'),
          artifactPath: resolve(
            repoRoot,
            'artifacts/member-balance.live.v1.json'
          ),
          inputHints: { memberId: '12345' },
        });
        console.log(JSON.stringify(result, null, 2));
      } finally {
        await targetServer.stop();
      }
      return;
    }
    default:
      console.error(`Unknown command: ${command}`);
      process.exitCode = 1;
  }
};

await main();
