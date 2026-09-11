# Evidence

This repository includes offline scripted evidence marked `mode: scripted-test`.

After the reviewer has already run repository setup, the exact live evidence command is:

```bash
OPENAI_API_KEY=your_key_here npm run evidence:live
```

The command starts the synthetic target locally, runs OpenAI-backed discovery against http://127.0.0.1:3000, and writes sanitized evidence into /evidence/discovery/. Do not submit fabricated live evidence.
