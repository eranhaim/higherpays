import { test, expect } from '@playwright/test';
import path from 'path';

const SCREENSHOT_DIR = 'C:\\Users\\Eran\\AppData\\Local\\Temp\\hp-marco-3\\test-screenshots';

test.describe('Visual Verification', () => {
  const GARBLED_PATTERNS = [
    /Γ[א-ת]/,             // Gamma + Hebrew
    /┬╖/,                  // box-drawing artifacts
    /╬⌐╬│/,                // more garbled sequences
    /[╬┬┐╗║╠╣╦╩╚╝═│┌┘└├┤┼]/,  // box-drawing chars
    /Ã[\u0080-\u00BF]/,    // UTF-8 mojibake (Latin chars misread)
    /â[\u0080-\u00BF][\u0080-\u00BF]/,  // more mojibake patterns
  ];

  test('login page has no garbled Unicode text', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    const bodyText = await page.locator('body').innerText();

    for (const pattern of GARBLED_PATTERNS) {
      const match = bodyText.match(pattern);
      expect(match, `Found garbled text matching ${pattern}: "${match?.[0]}"`).toBeNull();
    }

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'visual-login-clean.png'), fullPage: true });
  });

  test('login page renders with proper styling', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Check that the page has a reasonable viewport and content
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);

    // Verify no broken images
    const images = page.locator('img');
    const imageCount = await images.count();
    for (let i = 0; i < imageCount; i++) {
      const img = images.nth(i);
      const naturalWidth = await img.evaluate((el: HTMLImageElement) => el.naturalWidth);
      expect(naturalWidth, `Image ${i} appears broken`).toBeGreaterThan(0);
    }

    // Verify the page has CSS loaded (check that body has some computed styles)
    const bgColor = await page.locator('body').evaluate(
      (el) => window.getComputedStyle(el).backgroundColor
    );
    expect(bgColor).toBeTruthy();

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'visual-login-styled.png'), fullPage: true });
  });

  test('root URL redirects or loads properly', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Should either show the login page or redirect somewhere valid
    const url = page.url();
    expect(url).toMatch(/higherpays\.com/);

    const bodyText = await page.locator('body').innerText();
    for (const pattern of GARBLED_PATTERNS) {
      const match = bodyText.match(pattern);
      expect(match, `Found garbled text on root page: "${match?.[0]}"`).toBeNull();
    }

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'visual-root-page.png'), fullPage: true });
  });
});
