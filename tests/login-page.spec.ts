import { test, expect } from '@playwright/test';
import path from 'path';

const SCREENSHOT_DIR = 'C:\\Users\\Eran\\AppData\\Local\\Temp\\hp-marco-3\\test-screenshots';

test.describe('Login Page', () => {
  test('login page renders with username field (not email)', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Verify the login form exists
    const form = page.locator('form');
    await expect(form).toBeVisible();

    // Verify the username field label says 'Username' not 'Email'
    const usernameLabel = page.getByText('Username', { exact: false });
    await expect(usernameLabel).toBeVisible();

    // Verify there is no 'Email' label on the login form
    const emailLabel = page.getByText('Email', { exact: true });
    await expect(emailLabel).not.toBeVisible();

    // Verify input fields exist
    const usernameInput = page.locator('input[type="text"], input[name*="user"], input[placeholder*="user" i]').first();
    await expect(usernameInput).toBeVisible();

    const passwordInput = page.locator('input[type="password"]');
    await expect(passwordInput).toBeVisible();

    // Take a screenshot
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'login-page.png'), fullPage: true });
  });

  test('login form elements are interactive', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Verify submit button exists
    const submitButton = page.locator('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Login")');
    await expect(submitButton.first()).toBeVisible();

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'login-form-elements.png'), fullPage: true });
  });
});
