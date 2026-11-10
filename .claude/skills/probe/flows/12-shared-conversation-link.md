# Flow 12 — Share a conversation, open the link logged out

**Feature**: `app/chat.html` "Share" button sets `conversations.share_token`
(a uuid) and copies `https://aethyro.com/app/share.html?t=<token>`;
`app/share.html` renders it for anyone holding the link, no login. Read path
is the `get_shared_conversation(p_token uuid)` RPC (SECURITY DEFINER) — `anon`
deliberately has no table-level SELECT on `conversations`/`messages`.

## Steps
1. Throwaway account: send one message in `app/chat.html` so a conversation
   with 2 messages exists.
2. Click Share, copy the link (or read `share_token` via SQL).
3. In a fresh browser context with NO session, open the link. Expect the
   title, the message count ("2 messages · shared <date>") and both bubbles;
   assistant markdown rendered, user text as plain text.
4. Open the same link with a garbage token (`?t=00000000-0000-0000-0000-000000000000`
   and `?t=not-a-uuid`) -> the "not found" error card, no console exception.
5. Negative checks (REST, anon key only): `GET /rest/v1/conversations?select=id`
   and `/messages?select=id` -> 401/`42501` (no enumeration); `POST
   /rest/v1/rpc/get_shared_conversation {"p_token": "<other user's token>"}`
   returns that one conversation only because the token is the capability —
   confirm there is no way to list tokens.

## Expected outcome
Steps 3–4 as described; step 5 shows no enumeration path.

## History
**Found broken 2026-11-09 (`backend-reviewer` sweep).** Before the RPC the page
queried the tables directly; `anon` had policies but no SELECT grant, so every
logged-out visit showed the error card. See `checks/10-rls-policy-without-role-grant.sql`.
