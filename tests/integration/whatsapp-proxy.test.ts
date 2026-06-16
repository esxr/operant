import { describe, it, expect } from 'vitest';
import { formatGateMessage, parseReply } from '../../src/whatsapp.js';

describe('formatGateMessage', () => {
  it('formats review message with approve/reject options', () => {
    const msg = formatGateMessage({
      mode: 'review',
      specName: 'auth-flow',
      specDir: '/tmp/specs/auth-flow',
      artifactType: 'intent',
      artifactSummary: 'User auth with OAuth2',
    });
    expect(msg).toContain('REVIEW: auth-flow');
    expect(msg).toContain('INTENT');
    expect(msg).toContain('Reply *1* to APPROVE');
  });

  it('formats confirmation message', () => {
    const msg = formatGateMessage({
      mode: 'confirmation',
      specName: 'auth-flow',
      specDir: '/tmp/specs/auth-flow',
      featureSummary: 'OAuth2 login implemented',
      testResults: 'All 5 tests passed',
    });
    expect(msg).toContain('CONFIRMATION: auth-flow');
    expect(msg).toContain('All 5 tests passed');
  });

  it('formats demo invite message', () => {
    const msg = formatGateMessage({
      mode: 'demo_invite',
      specName: 'auth-flow',
      specDir: '/tmp/specs/auth-flow',
      meetUrl: 'https://meet.google.com/abc-defg-hij',
      meetCode: 'abc-defg-hij',
    });
    expect(msg).toContain('DEMO READY: auth-flow');
    expect(msg).toContain('abc-defg-hij');
  });
});

describe('parseReply', () => {
  it('parses "1" as approved', () => {
    expect(parseReply('1')).toEqual({ decision: 'approved' });
  });

  it('parses "2" as rejected', () => {
    expect(parseReply('2')).toEqual({ decision: 'rejected' });
  });

  it('parses approve keywords', () => {
    expect(parseReply('looks good, ship it')).toEqual({ decision: 'approved' });
  });

  it('parses reject keywords with feedback', () => {
    const result = parseReply('rejected - needs error handling');
    expect(result.decision).toBe('rejected');
    expect(result.feedback).toContain('needs error handling');
  });

  it('defaults unknown text to rejected with feedback', () => {
    const result = parseReply('I have concerns about the auth flow');
    expect(result.decision).toBe('rejected');
    expect(result.feedback).toBeDefined();
  });
});
