import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

// Stub env BEFORE importing the module (config.ts reads env on import)
vi.stubEnv('RETELL_API_KEY', 'test-retell-key');
vi.stubEnv('RETELL_AGENT_ID', 'test-agent-id');
vi.stubEnv('RETELL_PHONE_NUMBER', '+16505551234');

const server = setupServer(
  http.post('https://api.retellai.com/v2/create-phone-call', async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    return HttpResponse.json({
      call_id: 'call_test_123',
      from_number: body.from_number,
      to_number: body.to_number,
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('makeOutboundCall (local mode)', () => {
  it('calls Retell API and returns call_id', async () => {
    // Dynamic import after env is set
    const { makeOutboundCall } = await import('../../src/retell.js');
    const result = await makeOutboundCall('+16505551234', '+14155551234', 'test-agent-id');
    expect(result).toHaveProperty('call_id', 'call_test_123');
  });
});
