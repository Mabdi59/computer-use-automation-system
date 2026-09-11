import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';

import { PlaywrightSurfaceAdapter } from '../../src/surface/playwright.js';

describe('locator fallback order', () => {
  it('uses the first matching locator in priority order', async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<div id="first-miss"></div><div id="second">second-hit</div><div id="third">third-hit</div>');

    const adapter = await PlaywrightSurfaceAdapter.launch({
      targetUrl: 'http://127.0.0.1:3000',
      existingBrowser: browser,
      existingContext: context,
      existingPage: page,
    });

    const result = await adapter.perform({
      type: 'extract',
      outputKey: 'value',
      rationale: 'extract using fallback order',
      target: {
        name: 'Priority target',
        description: 'Proves fallback order',
        stableReason: 'Test fixture',
        risk: 'safe',
        priority: [
          { kind: 'css', css: '#missing' },
          { kind: 'css', css: '#second' },
          { kind: 'css', css: '#third' },
        ],
      },
    });

    expect(result.extracted).toBe('second-hit');
    await adapter.close();
    await browser.close();
  });
});
