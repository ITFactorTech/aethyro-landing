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

**2026-11-05 sweep — PASSED, with one real UI bug found (fix in draft PR
#216).** Generation receipt: "Receipt" opened the modal (payload: model,
credits, `sources.provider`/`actual_model`/`tools_used`/`memory_context_count`/
`document_context_count`, tokens, `generated_at`), Verify → `✓ Signature valid —
recomputed server-side…`, Download → `aethyro-generation-receipt-<id>.json`.
Deletion receipt: deleting the conversation opened the deletion modal (title,
`message_count: 2`, `memory_count: 2`), Verify → valid, Download works. A
`verify_deletion_receipt` call with a nonexistent id returns `Receipt not found`
(not `valid`). **Bug found:** on a short reply the hover-revealed Copy button
sat on top of the Receipt link (copy box x 658-687 vs link x 646-690;
`elementFromPoint` at the link centre = Copy), so a normal click on Receipt did
nothing — a Playwright `.click()` on `.mc-receipt-link` times out with
"`.msg-copy-btn` subtree intercepts pointer events". Until #216 merges, click
the link's left edge (`click({position:{x:3,y:7}})`) to reach it.
