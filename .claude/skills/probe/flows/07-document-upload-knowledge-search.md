# Flow 07 — Document upload → Knowledge tab → cross-conversation Search

**Feature**: `embed-content` function, `document_chunks`/
`memory_embeddings`, the Intelligence panel's Knowledge and Search tabs
(2026-10-02).

## Steps
1. Signed-in throwaway account: upload a short real document (plain text
   is enough) via the Intelligence panel → Knowledge tab (`#docFileInput`).
   (The composer's attach button attaches a file to one message; it does
   **not** add it to the knowledge base.)
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

**2026-11-05 sweep — PASSED only when the embedding quota was idle; FAILED
under burst (escalated to `codex`).** Upload via Knowledge tab → "zeph.txt added
to knowledge base", `embed-content` 200 `{chunks:1,has_embeddings:true}`, listed
as "TXT zeph.txt 317 B · 1 chunks". Search tab: a phrase from the doc → `doc`
result at 74% match; after a 75 s idle, a memory query ("who is the lighthouse
keeper on Skellig") → `chat` result (66%) + `doc` (33%); clicking the `chat` card
loaded the conversation and closed the panel, clicking the `doc` card switched
to the Knowledge tab with the "Opened in Knowledge tab" toast. **But:** two chat
messages sent ~2 s apart produced 4 `memory_embeddings` rows with `embedding IS
NULL`, and the Search tab then returned "No matches" for them — while a single
message sent after a ≥90 s idle embedded both rows and searched fine, and direct
`embed-content` search calls spaced 25 s apart both returned results. Across the
last 14 days 25-86% of all `memory_embeddings` rows (210 rows today, 181 null)
have no embedding, worst on burst days; `embed-content`'s `embedTexts()` returns
`null` on any non-OK Voyage response with no retry/log and still inserts the row.
Consistent with a per-minute embedding-provider limit (unconfirmed — needs the
Voyage tier/logs). The Search tab also fires two `embed-content` calls in
parallel and swallows failures as `{results:[]}`, so a throttled search is
indistinguishable from "nothing found". **To run this flow reliably:** idle ≥ 60-90
s before each memory-producing send and before each search, or the result is
noise.
