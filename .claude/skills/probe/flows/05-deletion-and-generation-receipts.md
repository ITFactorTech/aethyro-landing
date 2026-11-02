# Flow 05 — Signed deletion + generation receipts

**Feature**: `delete_conversation_with_receipt`/`verify_deletion_receipt`
(2026-09-27) and `create_generation_receipt`/`verify_generation_receipt`
(2026-10-05) — both HMAC-signed, both verifiable without trusting the
client.

## Steps
1. Signed-in throwaway account, send one real chat message → confirm a
   "📜 Receipt" button appears on the reply; open it, click Verify, confirm
   it reports valid, and confirm the JSON download works.
2. Delete the conversation containing that message → confirm a deletion-
   receipt modal appears with a payload/signature, click Verify, confirm
   valid.
3. Tamper check (optional, if easy to do client-side): confirm a hand-
   edited payload correctly fails verification rather than silently
   passing.

## Expected outcome
Both receipt types generate, display, and verify correctly; a tampered
payload is correctly rejected.

## Known workaround
None flow-specific.

## History
First run: see this skill's build PR (2026-11-02).
