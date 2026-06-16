import { describe, it, expect } from 'vitest';
import {
  transition,
  stateToPhase,
  classifyTranscript,
  deriveSpecName,
  InvalidTransitionError,
} from '../../src/state-machine.js';

// ---------------------------------------------------------------------------
// transition() — valid transitions
// ---------------------------------------------------------------------------

describe('transition() valid transitions', () => {
  it('idle + CALL_RECEIVED → call_active', () => {
    const r = transition('idle', 'CALL_RECEIVED');
    expect(r.to).toBe('call_active');
    expect(r.from).toBe('idle');
    expect(r.event).toBe('CALL_RECEIVED');
  });

  it('call_active + CALL_COMPLETED → triage', () => {
    const r = transition('call_active', 'CALL_COMPLETED');
    expect(r.to).toBe('triage');
  });

  it('triage + NEW_REQUIREMENTS → sdlc_intent with side effects', () => {
    const r = transition('triage', 'NEW_REQUIREMENTS', {
      specName: 'test-feature',
      specDir: '/tmp/spec/test-feature',
      requirements: 'Build a widget',
    });
    expect(r.to).toBe('sdlc_intent');
    const types = r.sideEffects.map((se) => se.type);
    expect(types).toContain('CREATE_SPEC_DIR');
    expect(types).toContain('WRITE_REQUIREMENTS');
    expect(types).toContain('LOAD_SKILL');
  });

  it('triage + REJECTED → idle', () => {
    const r = transition('triage', 'REJECTED');
    expect(r.to).toBe('idle');
  });

  it('sdlc_intent + ARTIFACT_PRODUCED → sdlc_review with TRIGGER_REVIEW_CALL', () => {
    const r = transition('sdlc_intent', 'ARTIFACT_PRODUCED', { specDir: '/tmp/spec/x' });
    expect(r.to).toBe('sdlc_review');
    expect(r.sideEffects.some((se) => se.type === 'TRIGGER_REVIEW_CALL')).toBe(true);
  });

  it('sdlc_review + REVIEW_APPROVED (reviewedArtifact=sdlc_intent) → sdlc_hld', () => {
    const r = transition('sdlc_review', 'REVIEW_APPROVED', {
      reviewedArtifact: 'sdlc_intent',
      specDir: '/tmp/spec/x',
    });
    expect(r.to).toBe('sdlc_hld');
  });

  it('sdlc_review + REVIEW_APPROVED (reviewedArtifact=sdlc_eis) → dev', () => {
    const r = transition('sdlc_review', 'REVIEW_APPROVED', {
      reviewedArtifact: 'sdlc_eis',
      specDir: '/tmp/spec/x',
    });
    expect(r.to).toBe('dev');
  });

  it('sdlc_review + REVIEW_REJECTED (reviewedArtifact=sdlc_hld) → sdlc_hld', () => {
    const r = transition('sdlc_review', 'REVIEW_REJECTED', {
      reviewedArtifact: 'sdlc_hld',
      specDir: '/tmp/spec/x',
    });
    expect(r.to).toBe('sdlc_hld');
  });

  it('dev + DEV_COMPLETE → audit', () => {
    const r = transition('dev', 'DEV_COMPLETE', { specDir: '/tmp/spec/x' });
    expect(r.to).toBe('audit');
  });

  it('dev + BLOCKER_DETECTED → dev_blocked', () => {
    const r = transition('dev', 'BLOCKER_DETECTED', { specDir: '/tmp/spec/x' });
    expect(r.to).toBe('dev_blocked');
  });

  it('dev_blocked + BLOCKER_RESOLVED → dev', () => {
    const r = transition('dev_blocked', 'BLOCKER_RESOLVED', { specDir: '/tmp/spec/x' });
    expect(r.to).toBe('dev');
  });

  it('audit + AUDIT_PASSED → demo_setup', () => {
    const r = transition('audit', 'AUDIT_PASSED', { specDir: '/tmp/spec/x' });
    expect(r.to).toBe('demo_setup');
  });

  it('audit + AUDIT_FAILED → audit_failed', () => {
    const r = transition('audit', 'AUDIT_FAILED');
    expect(r.to).toBe('audit_failed');
  });

  it('audit_failed + REVISION_READY → dev', () => {
    const r = transition('audit_failed', 'REVISION_READY', { specDir: '/tmp/spec/x' });
    expect(r.to).toBe('dev');
  });

  it('confirmation + USER_CONFIRMED → complete', () => {
    const r = transition('confirmation', 'USER_CONFIRMED', { specDir: '/tmp/spec/x' });
    expect(r.to).toBe('complete');
  });

  it('confirmation + USER_REJECTED → dev', () => {
    const r = transition('confirmation', 'USER_REJECTED', { specDir: '/tmp/spec/x' });
    expect(r.to).toBe('dev');
  });

  it('complete + RESET → idle', () => {
    const r = transition('complete', 'RESET');
    expect(r.to).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// transition() — invalid transitions
// ---------------------------------------------------------------------------

describe('transition() invalid transitions', () => {
  it('idle + ARTIFACT_PRODUCED → throws InvalidTransitionError', () => {
    expect(() => transition('idle', 'ARTIFACT_PRODUCED')).toThrow(InvalidTransitionError);
  });

  it('dev + CALL_RECEIVED → throws InvalidTransitionError', () => {
    expect(() => transition('dev', 'CALL_RECEIVED')).toThrow(InvalidTransitionError);
  });
});

// ---------------------------------------------------------------------------
// stateToPhase()
// ---------------------------------------------------------------------------

describe('stateToPhase()', () => {
  it.each([
    ['idle', 'idle'],
    ['sdlc_intent', 'sdlc'],
    ['dev', 'dev'],
    ['audit_failed', 'audit'],
    ['confirmation', 'confirmation'],
    ['demo_setup', 'demo'],
  ] as const)('%s → %s', (state, expectedPhase) => {
    expect(stateToPhase(state)).toBe(expectedPhase);
  });
});

// ---------------------------------------------------------------------------
// classifyTranscript()
// ---------------------------------------------------------------------------

describe('classifyTranscript()', () => {
  it('detects requirements from keyword', () => {
    expect(classifyTranscript('I need a feature that solves the login problem')).toBe('requirements');
  });

  it('detects confirmation from multiple keywords in short text', () => {
    expect(classifyTranscript('Looks good, ship it')).toBe('confirmation');
  });

  it('empty transcript → unknown', () => {
    expect(classifyTranscript('')).toBe('unknown');
  });

  it('callAnalysis with call_summary → requirements', () => {
    expect(classifyTranscript('', { call_summary: 'User wants a dashboard' })).toBe('requirements');
  });
});

// ---------------------------------------------------------------------------
// deriveSpecName()
// ---------------------------------------------------------------------------

describe('deriveSpecName()', () => {
  it('converts normal string to kebab-case', () => {
    expect(deriveSpecName('Add User Dashboard')).toBe('add-user-dashboard');
  });

  it('empty string → unnamed-spec', () => {
    expect(deriveSpecName('')).toBe('unnamed-spec');
  });

  it('truncates long strings', () => {
    const long = 'this is a very long feature name that should be truncated at fifty characters or fewer';
    const result = deriveSpecName(long);
    expect(result.length).toBeLessThanOrEqual(50);
  });
});
