# Evidence

This repository includes offline scripted evidence marked `mode: scripted-test`.

To generate genuine live discovery evidence after setting OPENAI_API_KEY, run:

```bash
npm install
npx playwright install chromium
npm run dev:target
npm run evidence:live
```

The live command runs discovery against http://127.0.0.1:3000 and writes fresh evidence into /evidence/discovery/. Do not submit fabricated live evidence.
