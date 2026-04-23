"use strict";

/**
 * 0012 — Appeal lifecycle columns on rejected submissions (v1.24.0).
 *
 * Background
 * ----------
 * Until now, a rejected achievement / JLAP / ID-flag submission was a
 * dead end: the user got a verifier note explaining why and that was
 * it. No second-look mechanism existed short of opening a new submission
 * (which loses the poster URL, the event date, the verifier's context).
 *
 * v1.24.0 adds a single appeal attempt per rejection cycle:
 *   - User writes up to 500 chars of context and POSTs to
 *     /api/<type>/:id/appeal.
 *   - The row stays status=rejected while appeal_status='pending'.
 *   - Verifier inbox surfaces the queue separately
 *     (/api/admin/<type>/appeals).
 *   - Verifier POSTs /api/admin/<type>/:id/appeal/resolve with either
 *       action=accept  -> row flips back to 'pending', appeal_status='accepted'
 *       action=deny    -> stays 'rejected', appeal_status='denied'
 *     Either terminal state locks the appeal. If the re-queued row is
 *     later rejected again, a fresh appeal cycle opens because
 *     server-side code resets appeal_status='' on every transition
 *     INTO 'rejected' (see PATCH handlers in server/index.js).
 *
 * Columns mirror exactly on every host table so the appeal helpers
 * in server/index.js can be parametric instead of per-type.
 */

module.exports = {
  id: "0012_submission_appeals",
  up(db, { tableHasColumn }) {
    const tables = ["achievements", "jlap_submissions", "id_flag_requests"];
    const cols = [
      ["appeal_text", "TEXT NOT NULL DEFAULT ''"],
      ["appeal_submitted_at", "INTEGER"],
      ["appeal_status", "TEXT NOT NULL DEFAULT ''"],
      ["appeal_resolved_at", "INTEGER"],
      ["appeal_resolved_by", "TEXT NOT NULL DEFAULT ''"],
      ["appeal_verifier_note", "TEXT NOT NULL DEFAULT ''"],
    ];
    for (const table of tables) {
      for (const [col, decl] of cols) {
        if (!tableHasColumn(db, table, col)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
        }
      }
    }

    // Partial indexes so the verifier "open appeals" queue stays fast
    // as rejected rows accumulate. Only indexes rows whose appeal is
    // actually waiting on staff action.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ach_appeal_pending
        ON achievements(appeal_submitted_at)
        WHERE appeal_status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_jlap_appeal_pending
        ON jlap_submissions(appeal_submitted_at)
        WHERE appeal_status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_idfr_appeal_pending
        ON id_flag_requests(appeal_submitted_at)
        WHERE appeal_status = 'pending';
    `);
  },
};
