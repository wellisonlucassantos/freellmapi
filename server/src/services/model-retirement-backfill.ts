// Retroactive retirement sweep for the request-attempt history (issue #1394).
//
// The live path (services/model-retirement.ts) only sees failures from requests
// that run WHILE the process is up. Issue #1394 reported installs whose models
// were already serving daily 410s for MONTHS before auto-retirement shipped:
// request_attempts is full of `model_not_found` outcomes for models nothing
// ever revisits, and the in-memory corroboration counters start from zero at
// every boot, so those corpses keep their routing slots forever.
//
// The history is the evidence. A model with N distinct requests that ALL ended
// `model_not_found` and ZERO successful attempts — across the entire retained
// history — has not answered a single request since it was added. That is the
// retirement verdict, made retroactively, with the same conservative bar as
// the live path (distinct requests, never one request failing over keys).
//
// What protects a healthy model:
//  - ANY 'ok' or 'committed' attempt in the model's history vetoes retirement.
//    A healthy model that hits one flaky 404 streak always has successes.
//  - RETIREMENT_BACKFILL_MIN_REQUESTS distinct failed requests are required,
//    matching RETIREMENT_CONFIRMATIONS_REQUIRED's "distinct requests, not
//    retries" rule at a higher bar.
//  - Only catalog-managed rows (source != 'user') are touched, and a tombstone
//    that already exists (user-deleted or upstream_eol) short-circuits.
//  - Everything reuses retireCatalogModelUpstream, so the dashboard shows the
//    same "retired upstream" state and a catalog refresh can lift it.

import type { Db } from '../db/types.js';
import { getDb } from '../db/index.js';
import { isCatalogManagedModel, retireCatalogModelUpstream, getCatalogModelTombstone } from './model-state.js';
import { providerLog } from '../lib/server-logs.js';

/** Distinct requests that must have failed with model_not_found, with zero
 * successes, before the backfill acts. Same conservatism as the live path's
 * corroboration gate (2), raised because this fires without a fresh signal. */
export const RETIREMENT_BACKFILL_MIN_REQUESTS = 3;

interface CandidateRow {
  id: number;
  platform: string;
  model_id: string;
  endpoint_scope: string;
  source: string;
  failures: number;
  latest_error: string | null;
}

/**
 * Pure candidate finder: catalog-managed models whose ENTIRE attempt history is
 * model_not_found across at least `minRequests` distinct requests. Returns the
 * strongest-evidence models first. Never throws for a missing attempts table
 * (fresh installs before the first request).
 */
export function findRetirementBackfillCandidates(
  db: Db,
  minRequests: number = RETIREMENT_BACKFILL_MIN_REQUESTS,
): CandidateRow[] {
  try {
    return db.prepare(`
      SELECT
        m.id, m.platform, m.model_id, m.endpoint_scope, m.source,
        COUNT(DISTINCT a.request_id) AS failures,
        (SELECT a2.error_summary FROM request_attempts a2
           WHERE a2.platform = m.platform
             AND a2.model_id = m.model_id
             AND a2.outcome = 'model_not_found'
           ORDER BY a2.id DESC LIMIT 1) AS latest_error
      FROM request_attempts a
      JOIN models m
        ON m.platform = a.platform
       AND m.model_id = a.model_id
      WHERE a.outcome = 'model_not_found'
        AND m.endpoint_scope = ''
      GROUP BY m.id
      HAVING COUNT(DISTINCT a.request_id) >= ?
        AND NOT EXISTS (
          SELECT 1 FROM request_attempts s
          WHERE s.platform = m.platform
            AND s.model_id = m.model_id
            AND s.outcome IN ('ok', 'committed')
        )
        AND NOT EXISTS (
          SELECT 1 FROM catalog_model_tombstones t
          WHERE t.kind = 'chat' AND t.platform = m.platform AND t.model_id = m.model_id
        )
      ORDER BY failures DESC
    `).all(minRequests) as CandidateRow[];
  } catch {
    return [];
  }
}

/**
 * Apply the verdict to one candidate. Separated from the query so the decision
 * logic is unit-testable and the DB writes stay on one code path with the live
 * retirement. Returns true iff this call retired the model.
 */
export function retireBackfillCandidate(db: Db, candidate: CandidateRow): boolean {
  if (!isCatalogManagedModel({ platform: candidate.platform, source: candidate.source })) return false;
  // An existing tombstone — user-deleted or already retired upstream — wins.
  if (getCatalogModelTombstone(db, 'chat', candidate.platform, candidate.model_id)) return false;
  const reason = `auto-retired from ${candidate.failures} historical requests that all failed with model_not_found`
    + (candidate.latest_error ? ` (last: ${candidate.latest_error})` : '');
  return retireCatalogModelUpstream(db, candidate.id, candidate.platform, candidate.model_id, reason);
}

/**
 * Boot-time sweep: retire models the retained history says are gone. Runs once,
 * while the DB is quiet, after initDb. Returns the number of models retired —
 * failures are logged, never thrown: a bad sweep must not stop the server.
 */
export function runRetirementBackfill(db: Db = getDb()): number {
  let retired = 0;
  try {
    for (const candidate of findRetirementBackfillCandidates(db)) {
      try {
        if (retireBackfillCandidate(db, candidate)) {
          retired++;
          providerLog(
            'warn',
            `[ModelRetirement] ${candidate.platform}/${candidate.model_id} disabled at boot — history shows no request ever succeeded for it: ${candidate.latest_error ?? 'model_not_found'}`,
            { provider: candidate.platform, model: candidate.model_id, event: 'model_retired' },
          );
        }
      } catch (err: any) {
        console.warn(`[ModelRetirement] backfill could not retire ${candidate.platform}/${candidate.model_id}: ${err?.message ?? err}`);
      }
    }
  } catch (err: any) {
    console.warn(`[ModelRetirement] backfill sweep failed: ${err?.message ?? err}`);
  }
  return retired;
}

/** Boot wrapper mirroring the other start/cleanup steps: logs, never throws. */
export function cleanupRetiredModelHistory(): number {
  const retired = runRetirementBackfill();
  if (retired > 0) {
    console.log(`[ModelRetirement] backfilled ${retired} model${retired === 1 ? '' : 's'} retired upstream (from request history, #1394)`);
  }
  return retired;
}
