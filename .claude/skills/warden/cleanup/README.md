# Farm account cleanup

Order matters, and the first four already protect the product without deleting anything.

1. **Stop new accounts getting value** (code, PRs #258 #259 #260): welcome/drip mail skips farm
   accounts, one signup bonus per Gmail mailbox, and the human check on email signups.
2. **Zero the dormant credits** (`zero-farm-credits.sql`): reversible, owner OK needed.
3. **Detect the next wave early** (`checks/14-new-signup-cluster-detector.sql`, run every sweep).
4. **Keep the rows for now.** Zeroed, un-mailed accounts cost nothing, and the rows are the evidence
   `warden`/`oracle` use to recognise the next wave; `checks/13-farm-accounts.sql` excludes them from
   the real-user numbers by rule.
5. **Delete later, only for tidiness** (`delete-farm-accounts.sql`): irreversible, not before
   2026-12-14, R1 only, in batches, after downloading the export. The Gmail "first of group"
   accounts and anything with a purchase, an admin row or a stored conversation are never
   deleted by rule.

Deletes and bulk writes cannot be confirmed from a cloud session (the Supabase connector's
confirmation dialog does not reach the owner; it timed out five times on 2026-11-14). Run the
irreversible scripts in the Supabase SQL editor.
