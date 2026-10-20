import { test, expect } from '@playwright/test';

test.describe('API Health Check', () => {
  test('GET /api/health returns ok: true', async ({ request }) => {
    const response = await request.get('/api/health');

    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body).toMatchObject({ ok: true });
  });
});
