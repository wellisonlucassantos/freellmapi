import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  findRetirementBackfillCandidates,
  runRetirementBackfill,
  RETIREMENT_BACKFILL_MIN_REQUESTS,
} from '../../services/model-retirement-backfill.js';
import { getCatalogModelTombstone } from '../../services/model-state.js';

// #1394: installs accumulated months of `model_not_found` attempts for models
// that were already dead upstream when auto-retirement shipped — the live
// path only judges failures it watches happen. The boot-time backfill reads
// the retained history instead. These tests pin BOTH directions: a model whose
// whole history is model_not_found gets retired, and one success vetoes.

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

let modelSeq = 0;
let requestSeq = 0;

function seedModel(platform: string, modelId: string, source = 'catalog'): number {
  const db = getDb();
  const n = ++modelSeq;
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, source)
    VALUES (?, ?, ?, 50, 50, 1, ?)
  `).run(platform, modelId, `Model ${n}`, source);
  const row = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as { id: number };
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 999, 1)').run(row.id);
  return row.id;
}

function addAttempt(requestId: number, platform: string, modelId: string, outcome: string, ordinal = 0, errorSummary: string | null = null): void {
  getDb().prepare(`
    INSERT INTO request_attempts (request_id, ordinal, platform, model_id, key_ordinal, outcome, start_offset_ms, duration_ms, error_summary)
    VALUES (?, ?, ?, ?, 1, ?, 0, 10, ?)
  `).run(requestId, ordinal, platform, modelId, outcome, errorSummary);
}

/** One terminal requests row + one attempt on it; returns the request id. */
function addRequest(platform: string, modelId: string, outcome: string, errorSummary: string | null = null): number {
  const db = getDb();
  const id = ++requestSeq;
  db.prepare(`
    INSERT INTO requests (id, platform, model_id, status, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(id, platform, modelId, outcome === 'ok' ? 'success' : 'error');
  addAttempt(id, platform, modelId, outcome, 0, errorSummary);
  return id;
}

function isRoutable(modelDbId: number): boolean {
  const row = getDb()
    .prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?')
    .get(modelDbId) as { enabled: number } | undefined;
  return row?.enabled === 1;
}

describe('retirement backfill from request history (#1394)', () => {
  it('retires a catalog model whose whole history is model_not_found across enough requests', () => {
    const id = seedModel('groq', 'backfill-dead');
    for (let i = 0; i < RETIREMENT_BACKFILL_MIN_REQUESTS; i++) {
      addRequest('groq', 'backfill-dead', 'model_not_found', "410: model 'backfill-dead' has reached its end of life");
    }
    expect(isRoutable(id)).toBe(true);

    const retired = runRetirementBackfill();
    expect(retired).toBeGreaterThanOrEqual(1);
    expect(isRoutable(id)).toBe(false);
    const tomb = getCatalogModelTombstone(getDb(), 'chat', 'groq', 'backfill-dead');
    expect(tomb?.source).toBe('upstream_eol');
    expect(tomb?.reason).toContain('end of life');
  });

  it('never retires a model with even one successful attempt', () => {
    const id = seedModel('groq', 'backfill-flaky-but-alive');
    for (let i = 0; i < RETIREMENT_BACKFILL_MIN_REQUESTS; i++) {
      addRequest('groq', 'backfill-flaky-but-alive', 'model_not_found');
    }
    addRequest('groq', 'backfill-flaky-but-alive', 'ok');

    runRetirementBackfill();
    expect(isRoutable(id)).toBe(true);
    expect(getCatalogModelTombstone(getDb(), 'chat', 'groq', 'backfill-flaky-but-alive')).toBeUndefined();
  });

  it('leaves models with fewer than the threshold of distinct failing requests alone', () => {
    const id = seedModel('groq', 'backfill-too-little-evidence');
    for (let i = 0; i < RETIREMENT_BACKFILL_MIN_REQUESTS - 1; i++) {
      addRequest('groq', 'backfill-too-little-evidence', 'model_not_found');
    }
    runRetirementBackfill();
    expect(isRoutable(id)).toBe(true);
  });

  it('counts DISTINCT requests, not sibling-key retries of one request', () => {
    const id = seedModel('groq', 'backfill-one-request');
    const req = addRequest('groq', 'backfill-one-request', 'model_not_found');
    for (let i = 1; i < RETIREMENT_BACKFILL_MIN_REQUESTS; i++) {
      addAttempt(req, 'groq', 'backfill-one-request', 'model_not_found', i);
    }
    runRetirementBackfill();
    expect(isRoutable(id)).toBe(true);
  });

  it('never touches a user-added model row', () => {
    const id = seedModel('custom', 'backfill-user-model', 'user');
    for (let i = 0; i < RETIREMENT_BACKFILL_MIN_REQUESTS; i++) {
      addRequest('custom', 'backfill-user-model', 'model_not_found');
    }
    runRetirementBackfill();
    expect(isRoutable(id)).toBe(true);
  });

  it('candidate finder surfaces exactly the dead model and orders by evidence', () => {
    const dead = seedModel('nvidia', 'backfill-candidate-finder');
    for (let i = 0; i < RETIREMENT_BACKFILL_MIN_REQUESTS + 2; i++) {
      addRequest('nvidia', 'backfill-candidate-finder', 'model_not_found', '410 Gone');
    }
    const candidates = findRetirementBackfillCandidates(getDb());
    const hit = candidates.find(c => c.platform === 'nvidia' && c.model_id === 'backfill-candidate-finder');
    expect(hit?.id).toBe(dead);
    expect(hit?.failures).toBe(RETIREMENT_BACKFILL_MIN_REQUESTS + 2);
    // The vetoed and under-threshold models never appear.
    expect(candidates.some(c => c.model_id === 'backfill-flaky-but-alive')).toBe(false);
    expect(candidates.some(c => c.model_id === 'backfill-too-little-evidence')).toBe(false);
  });

  it('a user tombstone blocks the backfill', () => {
    const id = seedModel('nvidia', 'backfill-user-tombstoned');
    getDb().prepare(`
      INSERT INTO catalog_model_tombstones (kind, platform, model_id, source, reason)
      VALUES ('chat', 'nvidia', 'backfill-user-tombstoned', 'user', 'user deleted')
    `).run();
    for (let i = 0; i < RETIREMENT_BACKFILL_MIN_REQUESTS; i++) {
      addRequest('nvidia', 'backfill-user-tombstoned', 'model_not_found');
    }
    runRetirementBackfill();
    // Still disabled? No — the tombstone means retireCatalogModelUpstream
    // short-circuits: the model keeps whatever state it has and no second
    // tombstone is written.
    expect(getCatalogModelTombstone(getDb(), 'chat', 'nvidia', 'backfill-user-tombstoned')?.source).toBe('user');
    void id;
  });

  it('is idempotent: a second sweep retires nothing new', () => {
    const first = findRetirementBackfillCandidates(getDb());
    expect(first.every(c => c.model_id !== 'backfill-dead')).toBe(true); // already tombstoned
    const retired = runRetirementBackfill();
    expect(retired).toBe(0);
  });
});
