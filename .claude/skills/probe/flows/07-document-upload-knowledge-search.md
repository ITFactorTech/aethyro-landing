# Flow 07 — Document upload → Knowledge tab → cross-conversation Search

**Feature**: `embed-content` function, `document_chunks`/
`memory_embeddings`, the Intelligence panel's Knowledge and Search tabs
(2026-10-02).

## Steps
1. Signed-in throwaway account: upload a short real document (plain text
   is enough) via the chat composer's attach button.
2. Confirm it appears in the Intelligence panel's Knowledge tab.
3. In a new conversation, use the Search tab to query for a phrase unique
   to the uploaded document → confirm it returns as a ranked result.
4. Send a couple of real chat messages, then search for a phrase from one
   of them → confirm it returns as a ranked memory result, distinct from
   the document result.
5. Click a document result → confirm it switches to the Knowledge tab;
   click a conversation result → confirm it jumps to that conversation.

## Expected outcome
Both source types (documents, conversation memory) are searchable and
correctly distinguished; navigation from a result works both ways.

## Known workaround
None flow-specific — this flow previously needed real throwaway-account
verification via direct API calls when live in-browser testing was
blocked by sandbox proxy flakiness (2026-10-02); if the same blocker
recurs, fall back to direct `embed-content` API calls as a partial
verification and say so explicitly rather than claiming the full UI flow
passed.

## History
First run: see this skill's build PR (2026-11-02).
