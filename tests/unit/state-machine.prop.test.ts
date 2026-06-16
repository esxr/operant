import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { transition, InvalidTransitionError } from '../../src/state-machine.js';
import type { State, FSMEvent } from '../../src/state-machine.js';

const ALL_STATES: State[] = [
  'idle', 'call_active', 'triage', 'sdlc_intent', 'sdlc_hld', 'sdlc_adr', 'sdlc_eis',
  'sdlc_review', 'dev', 'dev_blocked', 'audit', 'audit_failed',
  'demo_setup', 'demo_calling', 'demo_active', 'demo_feedback',
  'confirmation', 'complete',
];

const ALL_EVENTS: FSMEvent[] = [
  'CALL_RECEIVED', 'CALL_COMPLETED', 'NEW_REQUIREMENTS', 'CONFIRMATION_RECEIVED',
  'REJECTED', 'ARTIFACT_PRODUCED', 'REVIEW_APPROVED', 'REVIEW_REJECTED',
  'DEV_COMPLETE', 'BLOCKER_DETECTED', 'BLOCKER_RESOLVED', 'AUDIT_PASSED',
  'AUDIT_FAILED', 'REVISION_READY', 'USER_CONFIRMED', 'USER_REJECTED', 'RESET',
  'DEMO_READY', 'USER_JOINED_MEET', 'WALKTHROUGH_COMPLETE',
  'DEMO_APPROVED', 'DEMO_REJECTED', 'DEMO_SKIPPED', 'DEMO_FAILED',
];

describe('state-machine property tests', () => {
  it('transition never returns an unknown state', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_STATES),
        fc.constantFrom(...ALL_EVENTS),
        (state, event) => {
          try {
            const result = transition(state, event, { reviewedArtifact: 'sdlc_intent', specDir: '/tmp/test' });
            expect(ALL_STATES).toContain(result.to);
            expect(result.from).toBe(state);
            expect(result.event).toBe(event);
          } catch (e) {
            expect(e).toBeInstanceOf(InvalidTransitionError);
          }
        }
      ),
      { numRuns: 500 }
    );
  });

  it('sideEffects is always an array', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_STATES),
        fc.constantFrom(...ALL_EVENTS),
        (state, event) => {
          try {
            const result = transition(state, event, {});
            expect(Array.isArray(result.sideEffects)).toBe(true);
          } catch (e) {
            expect(e).toBeInstanceOf(InvalidTransitionError);
          }
        }
      ),
      { numRuns: 500 }
    );
  });

  it('random walk through FSM never crashes', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...ALL_EVENTS), { minLength: 5, maxLength: 20 }),
        (events) => {
          let current: State = 'idle';
          for (const event of events) {
            try {
              const result = transition(current, event, {
                reviewedArtifact: 'sdlc_intent',
                specDir: '/tmp/test',
                specName: 'test-spec',
                requirements: 'test',
              });
              current = result.to;
            } catch (e) {
              expect(e).toBeInstanceOf(InvalidTransitionError);
            }
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});
