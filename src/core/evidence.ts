import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';

export class EvidenceWriter {
  readonly correlationId: string;
  readonly runDir: string;
  readonly files = new Set<string>();

  constructor(private readonly baseDir: string, correlationId = randomUUID()) {
    this.correlationId = correlationId;
    this.runDir = join(baseDir, correlationId);
  }

  async init(runSummary: Record<string, unknown>): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
    await this.writeJson('run.json', { correlationId: this.correlationId, ...runSummary });
  }

  async writeJson(fileName: string, value: unknown): Promise<string> {
    const fullPath = join(this.runDir, fileName);
    await writeFile(fullPath, JSON.stringify(value, null, 2));
    this.files.add(fullPath);
    return fullPath;
  }

  async appendEvent(event: Record<string, unknown>): Promise<void> {
    const fullPath = join(this.runDir, 'events.jsonl');
    const line = `${JSON.stringify(event)}\n`;
    await writeFile(fullPath, line, { flag: 'a' });
    this.files.add(fullPath);
  }

  registerFile(fullPath: string): void {
    this.files.add(fullPath);
  }

  async writeManifest(mode: string, provider: string): Promise<string> {
    const hashes: Record<string, string> = {};
    const entries = Array.from(this.files.values()).sort();
    for (const filePath of entries) {
      const content = await readFile(filePath);
      hashes[relative(this.runDir, filePath)] = createHash('sha256').update(content).digest('hex');
    }
    return this.writeJson('manifest.json', {
      correlationId: this.correlationId,
      mode,
      provider,
      generatedAt: new Date().toISOString(),
      fileHashes: hashes,
    });
  }

  async listFiles(): Promise<string[]> {
    await readdir(this.runDir);
    return Array.from(this.files.values()).sort();
  }
}
