import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Config module reads env at import time, so we must stub env BEFORE importing.
// Use dynamic import inside each test to get a fresh module.

describe('getMode()', () => {
  beforeEach(() => {
    vi.stubEnv('OPERANT_API_KEY', '');
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns "local" by default', async () => {
    vi.stubEnv('OPERANT_API_KEY', '');
    const { getMode } = await import('../../src/config.js');
    // Empty string is falsy, so getOperantApiKey returns null
    expect(getMode()).toBe('local');
  });

  it('returns "cloud" when OPERANT_API_KEY is set', async () => {
    vi.stubEnv('OPERANT_API_KEY', 'sk-test-key-123');
    const { getMode } = await import('../../src/config.js');
    expect(getMode()).toBe('cloud');
  });
});

describe('getDataDir()', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns default path when no env var', async () => {
    vi.stubEnv('OPERANT_PI_DATA_DIR', '');
    const { getDataDir } = await import('../../src/config.js');
    // When env is empty string, it's truthy — so we need to delete it
    delete process.env.OPERANT_PI_DATA_DIR;
    const result = getDataDir();
    expect(result).toContain('spec');
    expect(result).toContain('.operant');
  });

  it('returns env var when set', async () => {
    vi.stubEnv('OPERANT_PI_DATA_DIR', '/custom/data/dir');
    const { getDataDir } = await import('../../src/config.js');
    expect(getDataDir()).toBe('/custom/data/dir');
  });
});

describe('readState() / writeState() round-trip', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'operant-test-'));
    vi.stubEnv('OPERANT_PI_DATA_DIR', tmpDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('readState returns idle when no state file exists', async () => {
    const { readState } = await import('../../src/config.js');
    expect(readState()).toBe('idle');
  });

  it('writeState then readState round-trips correctly', async () => {
    const { readState, writeState } = await import('../../src/config.js');
    writeState('sdlc_intent');
    expect(readState()).toBe('sdlc_intent');

    writeState('dev');
    expect(readState()).toBe('dev');
  });

  it('state file contains the written state', async () => {
    const { writeState } = await import('../../src/config.js');
    writeState('audit');
    const content = readFileSync(join(tmpDir, 'current-state.txt'), 'utf-8');
    expect(content.trim()).toBe('audit');
  });
});
