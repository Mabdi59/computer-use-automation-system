import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from 'playwright';

import {
  observationSchema,
  type DirectTarget,
  type LLMAction,
  type Observation,
} from '../core/schemas.js';

const firstText = async (locator: Locator): Promise<string> =>
  ((await locator.first().textContent()) ?? '').trim();

export interface SurfaceAdapter {
  getCurrentUrl(): Promise<string>;
  getContext(): BrowserContext;
  getPage(): Page;
  observe(screenshotDir?: string, stepId?: string): Promise<Observation>;
  perform(
    action: LLMAction,
    target?: DirectTarget
  ): Promise<{ extracted?: string }>;
  consumeDialogs(): string[];
  enableHumanAudit(
    callback: (event: Record<string, unknown>) => void
  ): Promise<void>;
  close(): Promise<void>;
}

const toFrameName = (frame: Frame): string => frame.name() || 'main';

export class PlaywrightSurfaceAdapter implements SurfaceAdapter {
  private static readonly auditBindingContexts = new WeakSet<BrowserContext>();

  static async launch(options: {
    targetUrl: string;
    headed?: boolean;
    existingBrowser?: Browser;
    existingContext?: BrowserContext;
    existingPage?: Page;
  }): Promise<PlaywrightSurfaceAdapter> {
    const browser =
      options.existingBrowser ??
      (await chromium.launch({ headless: !options.headed }));
    const context = options.existingContext ?? (await browser.newContext());
    const page = options.existingPage ?? (await context.newPage());
    if (!options.existingPage) {
      await page.goto(options.targetUrl);
    }
    return new PlaywrightSurfaceAdapter(browser, context, page, {
      ownsBrowser: !options.existingBrowser,
      ownsContext: !options.existingContext,
      ownsPage: !options.existingPage,
    });
  }

  private readonly dialogs: string[] = [];
  private humanAuditEnabled = false;

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly ownership: {
      ownsBrowser: boolean;
      ownsContext: boolean;
      ownsPage: boolean;
    }
  ) {
    this.page.on('dialog', async (dialog) => {
      this.dialogs.push(dialog.message());
      await dialog.dismiss().catch(() => undefined);
    });
  }

  getContext(): BrowserContext {
    return this.context;
  }

  getPage(): Page {
    return this.page;
  }

  async getCurrentUrl(): Promise<string> {
    return this.page.url();
  }

  private async resolveFrame(target?: {
    frameName?: string;
    frameUrlIncludes?: string;
  }): Promise<Frame | Page> {
    if (!target?.frameName && !target?.frameUrlIncludes) {
      return this.page;
    }
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const frame = this.page
        .frames()
        .find(
          (entry) =>
            (!target.frameName || entry.name() === target.frameName) &&
            (!target.frameUrlIncludes ||
              entry.url().includes(target.frameUrlIncludes))
        );
      if (frame) {
        return frame;
      }
      await this.page.waitForTimeout(100);
    }
    throw new Error(
      `Unable to resolve frame ${target.frameName ?? target.frameUrlIncludes}`
    );
  }

  private async buildLocator(target: DirectTarget): Promise<Locator> {
    let lastError: Error | undefined;
    for (const entry of target.priority) {
      try {
        let locator: Locator;
        switch (entry.kind) {
          case 'visual':
            continue;
          case 'role':
            locator = (await this.resolveFrame(entry)).getByRole(
              entry.role as any,
              { name: entry.name }
            );
            break;
          case 'label':
            locator = (await this.resolveFrame(entry)).getByLabel(entry.label);
            break;
          case 'text': {
            const scope = await this.resolveFrame(entry);
            locator = scope.getByText(entry.text, { exact: false });
            if (entry.scopeText) {
              locator = scope
                .getByText(entry.scopeText, { exact: false })
                .locator(`..`)
                .getByText(entry.text, { exact: false });
            }
            break;
          }
          case 'css':
            locator = (await this.resolveFrame(entry)).locator(entry.css);
            break;
        }
        await locator
          .first()
          .waitFor({ state: 'attached', timeout: 1_000 })
          .catch(() => undefined);
        if ((await locator.count()) > 0) {
          return locator.first();
        }
      } catch (error) {
        lastError = error as Error;
      }
    }
    throw lastError ?? new Error(`Unable to resolve target ${target.name}`);
  }

  async observe(screenshotDir?: string, stepId = 'step'): Promise<Observation> {
    const frameSummaries = this.page
      .frames()
      .map((frame) => ({ name: toFrameName(frame), url: frame.url() }));
    const frameTexts = await Promise.all(
      this.page.frames().map(async (frame) =>
        frame
          .locator('body')
          .innerText()
          .catch(() => '')
      )
    );
    const elementSummary = await this.page.evaluate(() => {
      const selectors = Array.from(
        document.querySelectorAll('button,a,input,select,h1,h2,td,label')
      ).slice(0, 20);
      return selectors.map((element) => {
        const text = (element.textContent || '').trim();
        const label =
          element.getAttribute('aria-label') ||
          (element instanceof HTMLInputElement ||
          element instanceof HTMLSelectElement
            ? element.name
            : '');
        return `${element.tagName.toLowerCase()}:${label || text}`.trim();
      });
    });

    let screenshotPath: string | undefined;
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      screenshotPath = join(screenshotDir, `${stepId}.png`);
      await this.page.screenshot({ path: screenshotPath, fullPage: true });
    }

    return observationSchema.parse({
      url: this.page.url(),
      title: await this.page.title(),
      visibleText: frameTexts.filter(Boolean).join('\n').slice(0, 4_000),
      elementSummary,
      frames: frameSummaries,
      dialogs: [...this.dialogs],
      screenshotPath,
    });
  }

  consumeDialogs(): string[] {
    const dialogs = [...this.dialogs];
    this.dialogs.length = 0;
    return dialogs;
  }

  async perform(
    action: LLMAction,
    target?: DirectTarget
  ): Promise<{ extracted?: string }> {
    switch (action.type) {
      case 'navigate':
        await this.page.goto(
          action.url ?? new URL(action.route ?? '/', this.page.url()).toString()
        );
        return {};
      case 'click': {
        const locator = await this.buildLocator(target ?? action.target!);
        await locator.click();
        return {};
      }
      case 'type': {
        const locator = await this.buildLocator(target ?? action.target!);
        await locator.fill(action.value);
        return {};
      }
      case 'select': {
        const locator = await this.buildLocator(target ?? action.target!);
        await locator.selectOption(action.value);
        return {};
      }
      case 'wait':
        await this.page.waitForTimeout(action.ms);
        return {};
      case 'extract': {
        const locator = await this.buildLocator(target ?? action.target!);
        const extracted = await firstText(locator);
        return {
          extracted: action.pattern
            ? (extracted.match(new RegExp(action.pattern))?.[0] ?? extracted)
            : extracted,
        };
      }
      case 'assert': {
        if (action.condition === 'urlIncludes') {
          if (!this.page.url().includes(action.expected)) {
            throw new Error(`URL did not include ${action.expected}`);
          }
          return {};
        }
        const locator = await this.buildLocator(target ?? action.target!);
        const text =
          action.condition === 'containsText' ? await locator.innerText() : '';
        if (action.condition === 'visible' && !(await locator.isVisible())) {
          throw new Error(
            `Target ${target?.name ?? action.target?.name} was not visible`
          );
        }
        if (
          action.condition === 'containsText' &&
          !text.includes(action.expected)
        ) {
          throw new Error(`Text did not include ${action.expected}`);
        }
        return {};
      }
      case 'finish':
      case 'escalate':
        return {};
      default:
        throw new Error(
          `Unsupported action ${(action as { type: string }).type}`
        );
    }
  }

  async enableHumanAudit(
    callback: (event: Record<string, unknown>) => void
  ): Promise<void> {
    if (this.humanAuditEnabled) {
      return;
    }
    this.humanAuditEnabled = true;
    if (!PlaywrightSurfaceAdapter.auditBindingContexts.has(this.context)) {
      await this.context.exposeBinding(
        'reportAutomationAuditEvent',
        (_source, event) => callback(event)
      );
      PlaywrightSurfaceAdapter.auditBindingContexts.add(this.context);
    }
    await this.page.addInitScript(() => {
      const reporter = (
        window as unknown as {
          reportAutomationAuditEvent: (event: Record<string, unknown>) => void;
        }
      ).reportAutomationAuditEvent;
      if (
        (window as unknown as { __automationAuditAttached?: boolean })
          .__automationAuditAttached
      ) {
        return;
      }
      (
        window as unknown as { __automationAuditAttached?: boolean }
      ).__automationAuditAttached = true;
      const redact = (target: EventTarget | null) => {
        if (!(target instanceof HTMLElement)) {
          return { label: 'unknown' };
        }
        const name =
          target.getAttribute('name') ||
          target.getAttribute('aria-label') ||
          target.id ||
          target.textContent ||
          target.tagName;
        const sensitive =
          /password|payment|ssn|social security|token|cookie/i.test(name);
        return {
          label: name.trim().slice(0, 120),
          value: sensitive
            ? '[REDACTED]'
            : (target as HTMLInputElement).value?.slice(0, 64),
        };
      };
      document.addEventListener(
        'click',
        (event) => {
          reporter({
            type: 'click',
            at: window.location.href,
            ...redact(event.target),
          });
        },
        true
      );
      document.addEventListener(
        'input',
        (event) => {
          reporter({
            type: 'input',
            at: window.location.href,
            ...redact(event.target),
          });
        },
        true
      );
      window.addEventListener('hashchange', () => {
        reporter({ type: 'navigation', at: window.location.href });
      });
    });
    const attachListeners = async (frame: Frame | Page): Promise<void> => {
      await frame
        .evaluate(() => {
          const reporter = (
            window as unknown as {
              reportAutomationAuditEvent: (
                event: Record<string, unknown>
              ) => void;
            }
          ).reportAutomationAuditEvent;
          if (
            (window as unknown as { __automationAuditAttached?: boolean })
              .__automationAuditAttached
          ) {
            return;
          }
          (
            window as unknown as { __automationAuditAttached?: boolean }
          ).__automationAuditAttached = true;
          const redact = (target: EventTarget | null) => {
            if (!(target instanceof HTMLElement)) {
              return { label: 'unknown' };
            }
            const name =
              target.getAttribute('name') ||
              target.getAttribute('aria-label') ||
              target.id ||
              target.textContent ||
              target.tagName;
            const sensitive =
              /password|payment|ssn|social security|token|cookie/i.test(name);
            return {
              label: name.trim().slice(0, 120),
              value: sensitive
                ? '[REDACTED]'
                : (target as HTMLInputElement).value?.slice(0, 64),
            };
          };
          document.addEventListener(
            'click',
            (event) => {
              reporter({
                type: 'click',
                at: window.location.href,
                ...redact(event.target),
              });
            },
            true
          );
          document.addEventListener(
            'input',
            (event) => {
              reporter({
                type: 'input',
                at: window.location.href,
                ...redact(event.target),
              });
            },
            true
          );
          window.addEventListener('hashchange', () => {
            reporter({ type: 'navigation', at: window.location.href });
          });
        })
        .catch(() => undefined);
    };
    await attachListeners(this.page);
    for (const frame of this.page.frames()) {
      if (frame === this.page.mainFrame()) {
        continue;
      }
      await attachListeners(frame);
    }
    this.page.on('framenavigated', async (frame) => {
      callback({
        type: 'navigation',
        at: frame.url(),
        frame: toFrameName(frame),
      });
      if (frame !== this.page.mainFrame()) {
        await attachListeners(frame);
      }
    });
  }

  async close(): Promise<void> {
    if (this.ownership.ownsPage) {
      await this.page.close();
    }
    if (this.ownership.ownsContext) {
      await this.context.close();
    }
    if (this.ownership.ownsBrowser) {
      await this.browser.close();
    }
  }
}
