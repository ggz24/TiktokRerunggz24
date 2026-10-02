# AI replies in TikTok chat

## Current runtime (2026-10-02, session sender update)

The default runtime is now `SessionChat`, replacing headless Chromium. It receives public LIVE comments with `tiktok-live-connector` 2.5.0 in anonymous mode and sends replies directly to the observed Shop chat endpoint with an encrypted account-scoped cURL/session recipe. No extension or persistent user browser is required. The receiver never gets the account Cookie: its third-party signing service receives public connection context only. Set optional `EULER_STREAM_API_KEY` on the server if signing requires a key or a higher quota. Do not enable authenticated WebSocket options without a separately authorized credential destination.

The authenticated web `chat-session` POST validates the capture, verifies its Cookie holder against the selected account, encrypts it with AES-GCM and owner/account/feature AAD, and returns only success. At the user's explicit request, its GET returns the saved cURL to the account owner with `Cache-Control: no-store`; the textarea loads it once, preserves unsaved edits and keeps it after saving. Routine state polling exposes only `hasCapture`. The receiver discovers the verified handle's current room; the sender replaces the captured room with this independently discovered room. It closes or rejects sending after disconnect, account changes and old-room events. A rejected send requests a new capture; ambiguous sends are not retried.

On 2026-10-02, a real anonymous LIVE connection received v3 `WebcastChatMessage` payloads containing `content`, `user.id`, and `common.msgId/createTime/roomId`. The prior receiver expected legacy `comment` and `user.userId`, so it silently discarded all these events. It now accepts the real v3 fields (retaining legacy compatibility) and rejects host messages and mismatched-room events. Regression tests cover this actual payload shape.

The corrected receiver was tested against the user's running LIVE using the existing encrypted session and AI settings: a fresh viewer question reached the real AI provider and direct TikTok sender, and history recorded `sent`. The user confirmed the answer appeared in chat, then stopped the stream. The local API and web containers were updated afterward and reported healthy. Browser verification confirmed AUTO remains enabled and the saved cURL textarea remains populated after reload. The API suite passes 70 tests, including owner-only/no-store retrieval and v3 event handling. This verifies the tested account/session, not indefinite session validity or every TikTok account.

Local API and web have been rebuilt and restarted after the user ended LIVE. GGZ24's session recipe has been saved encrypted and AUTO armed using its existing AI key and knowledge. UI verification confirmed the enabled checkbox, saved session and offline message. The live receiver test returned “user isn't online”, consistent with the ended LIVE. This does not verify the signer or receive-to-AI-to-send flow during a real LIVE. Actual receiver readiness and any signing-service key/quota requirement must be checked on the next LIVE. Keep one API replica.

The sections below record earlier experiments; their browser default and mandatory-connection-at-save statements are superseded by this section.

## Implemented locally

- Open **ตอบอัตโนมัติ** to select an account, or open account settings → **AI ช่วยตอบ**.
- Set an OpenAI API key, model, product facts, sales instructions, word targets, banned terms and rate limits.
- AUTO can now be enabled and saved before the chat connection is ready. This arms the preference only: processing still requires a ready connector and a matching current LIVE room. The UI explicitly shows that it is waiting for comments; it does not claim the bot is responding.
- Account keys are encrypted with `ACCOUNT_ENCRYPTION_KEY`, with authenticated owner/account context. Blank key input preserves the existing key. Keys are never returned to the browser.
- Preview uses the current form and saved/new key; it calls OpenAI but never sends TikTok messages. It consumes provider quota. Requests use the fixed OpenAI URL and `store: false`.
- The word range is a generation instruction. The service rejects replies longer than 100 Unicode code points, prohibited text and control characters. These filters do not prove factual correctness.
- History is limited to the latest 100 entries; displayed statistics count this window and exclude previews. Entries older than seven days are removed on completion of another request.

## Local Chrome integration — live verification required

ChatBridge is now injected into runtime. The local Chrome extension relays protobuf frames and lets the TikTok page prepare its own signed chat requests through its existing input. AUTO stays gated until an account/room-scoped pairing has a fresh heartbeat and matching page identity. DOM sending still needs a viewer-visible LIVE test; synthetic tests do not prove TikTok accepts extension events. See extensions/livehub-chat/README.md for installation.

### Supplied chat request capture

The supplied capture has been validated offline against `POST /api/v1/streamer_desktop/message/chat`. `packages/tiktok-client/src/live-chat-curl.ts` parses its content, room context, sender key and Cookie without executing shell commands or sending a request. Its safe summary excludes credentials, room IDs and message text. The original signed URL and body remain untouched.

The URL contains `X-Bogus`, `X-Gnarly`, `msToken` and `X-Tts-Oec-Bsid`. Reusing those captured values with a newly generated message has not been verified. The capture is not a working dynamic sender. Fresh signature/session handling must be verified before enabling automatic replies. Real captures must remain outside the repository.

### Captured receiver and response evidence (2026-10-02)

Read-only inspection in Chrome profile Pimnatcha66 found the Shop receiver at `wss://webcast-ws.tiktok.com/webcast/im/ws_proxy/ws_reuse_supplement/`, using protobuf frames. The user then supplied a local file containing a `WebcastChatMessage` with text `Test`. `decodeLiveChatFrame` in `packages/tiktok-client/src/live-chat-frame.ts` successfully decodes that real capture and preserves its 64-bit event and room identifiers as decimal strings. It supports the observed gzip/none envelopes, skips non-chat events and other rooms, deduplicates events inside each frame, limits decompression and rejects malformed frames. The decoder is used by the local Chrome relay. TikTok retains responsibility for the page WebSocket connection and reconnect; the extension hooks new connections from page load. Fresh events must carry a timestamp, match the paired current room, and not be from the host. Account/room ownership must be established by the connector, not inferred from a supplied frame.

The observed chat-send response was `code: 0` with `data.punish: 1`. The user confirmed that viewers saw both subsequently supplied messages. This shows that flag 1 does not by itself indicate hidden delivery for these captures. `inspectLiveChatResponse` accepts the observed flag 1 (and flag 0) with code 0, while keeping `deliveryConfirmed: false`: an API response alone does not prove viewer-visible delivery. Unknown flags require review, and sends are not automatically retried. No actual capture, sender credential or profile data is checked into this repository.

Two additional user-supplied chat cURLs were parsed offline. They target the same room, contain different messages (5 and 16 Unicode code points) and have the same body structure. Between captures, the timestamp, Cookie, `ec_streamer_key`, `msToken`, `X-Bogus`, `X-Gnarly` and `X-Tts-Oec-Bsid` all differ. This comparison does not establish why each value changed or prove that each must change per message. Both supplied responses contain `code: 0`, `punish: 1` and Thai language classification, and the user confirmed viewer-visible delivery for both. A static captured request is insufficient evidence for dynamic AI sending; use a verified signing/session provider or an authorized browser-side sender that lets the TikTok application prepare its own request.

The implemented bridge has a one-tab lease, a hashed bearer token expiring after 12 hours, current LIVE context checks, bounded frame processing, and a single pending send. Pausing AUTO cancels undispatched jobs. Sent jobs are never retried after ambiguous results. Frames arriving while an AI reply is processed are skipped to avoid a stale backlog. A changed room requires new pairing.

The internal `/api/v1/ai-comments/:accountId/events` endpoint requires the internal token and owner headers. It is not exposed by the web proxy. A connector must not rely on a browser refresh to receive comments.

Rate limiting uses an in-process account lock, with persisted recent attempts. Deploy one API replica until a distributed lock/outbox is implemented. Event deduplication is persisted but is bounded by history retention.

## Routes

Owner-scoped internal routes: GET state, PATCH settings, POST preview, POST models, POST events. Web routes expose state, settings, preview, models and authenticated bridge pairing/status/revoke; mutations check same origin and authentication. Provider errors are sanitized.

## Verification

`apps/api/src/ai-comments.test.ts` covers preview isolation, readiness gates, deduplication, cooldown, owner separation, banned text, long answers, disabling/closing a room during generation, encrypted keys, credential masking and route authorization. Tests use fake generators/connectors, not real TikTok writes or OpenAI keys.

`packages/tiktok-client/test/live-chat-curl.test.ts` uses fake credentials to verify exact request parsing, secret-free summaries and rejection of invalid hosts, paths, bodies, missing Cookies and appended shell commands. The client suite passes 31 tests, including the chat parser tests. The supplied real capture also passed offline parsing; this does not verify TikTok acceptance.

No production deployment is included in this change.

The client suite now passes 35 tests, including chat frame decoding, gzip/none handling, 64-bit ID preservation, room filtering, deduplication, corruption/size limits and response interpretation. The real user-supplied `Test` capture was also checked offline with the compiled decoder. No live TikTok message was sent during these checks.

## Scoped extension relay

POST /api/chat-bridge accepts a room-scoped bearer token without session cookies. This is the explicit exception to normal same-origin mutations: extension origins get CORS, regular cross-origin web requests are rejected. The service worker alone retains the token in trusted session storage; the TikTok page receives only room/handle/job data. The fixed relay target is localhost:3100. Pairings are in memory and expire on API restart. Keep one API replica. No remote deployment support is included for the extension.

Bridge tests cover expiry, owner isolation, wrong-tab rejection, current-room changes, one-time issue/ack, AUTO disable/revoke, route auth, and viewer frame → AI → queue flow. Extension VM tests verify token isolation and unchanged unrelated network calls. Real page selectors, synthetic Enter acceptance and viewer delivery still require manual verification.


## Server connector (2026-10-02)

The default runtime connector is now ServerChat, not the local Chrome extension. Docker's API image includes Chromium and playwright-core. Each account opens an isolated ephemeral browser context with its saved decrypted TikTok Cookie and original User-Agent. Credentials/storage state are not written to disk. TikTok's own page prepares chat requests; no old signed cURL is replayed and no signing endpoint is invented.

Open AI settings, start LIVE, press ตรวจการเชื่อมต่อแชท and wait for server readiness. Then configure AI, enable and save. Enabled accounts are checked every ten seconds independently of the user's browser. Sessions close after room changes/stops; failed connections back off. Chromium sessions add RAM usage per active chat account. Keep one API replica.

This path has mock integration coverage. Actual TikTok Shop authentication, page selectors, WebSocket room binding and viewer-visible delivery still require a LIVE test. A login challenge or insufficient Shop cookies keeps AUTO unavailable and asks for a session update; the service does not bypass challenges. Installing an extension is no longer required by the default UI. The extension source remains an optional experimental implementation, disconnected from the default AI sender.

This change updates the local project; it has not deployed to the reference website at 45.154.24.208:3000. No source or access to that site's server has been provided in this task.


## Verified findings (2026-10-02, local test with a real LIVE running)

- **OpenAI generation works**: with the stored key, two sample comments produced short Thai replies (`status: draft`), nothing was sent to TikTok.
- **The server connector (headless Chromium) cannot log in to TikTok Shop.** With valid logged-in cookies (the account import cookie, and a Shop-origin cookie from a saved product-set cURL; TikTok's passport check returned success for both) the Shop dashboard redirects to `business.tiktokshop.com/us/creator/live` showing "Log in / Join now". Evading the site's automation checks is not an option, so ServerChat will not become ready with injected cookies.
- **Public viewer page is not a substitute**: `tiktok.com/@handle/live` loads and shows the room ID, but `webcast/room/enter` returns 403 and the comment box says "Comments off".
- ServerChat now follows the account's own current LIVE room (discovered from the Shop page) instead of requiring a LIVE started from this app. It is tested with mocks, but is only useful once a logged-in Shop page is available.
- The extension path (`extensions/livehub-chat`) uses the user's real logged-in Chrome tab and is the remaining viable route. It is still gated on a LIVE started by this app (`session.status === 'live'` in `index.ts`), which also needs the RTMP problem fixed, so that gate should be replaced by room discovery from the paired Shop tab.

## Direct session sender experiment (2026-10-02, later test)

The user supplied another successful chat capture and authorized a server-side send test. A new message was sent from the local API container to the supplied room, using the supplied account session cookies and sender key. The request used the observed Shop `message/chat` endpoint, new content and current timestamp, without `X-Bogus`, `X-Gnarly`, URL `msToken` or `X-Tts-Oec-Bsid`. TikTok returned HTTP 200, code 0, punish 1 and a chat ID. A second test used `sendLiveChatWithSession` and also received acceptance. The user then supplied a screenshot showing both test messages in the Shop chat. Viewer-side visibility has not been independently inspected. This supersedes the earlier assumption that a browser signer is necessarily required for sending.

`sendLiveChatWithSession` now implements this transport in the client package. It parses cURL as data, preserves session headers, uses only the observed fixed TikTok endpoint, creates fresh content/time, requires a caller-provided current-room check, and never retries ambiguous sends. Forty client tests pass, including exact captured sending, session-only sending, changed-room rejection and error sanitization.

This function is not yet wired into the default AI connector. Receiving current comments and independently discovering/binding the account's active Shop room remain separate work. The attempted direct `live_room_info/get` lookup returned code 0 without data; that result does not establish that the supplied LIVE was closed. No general claim about signature requirements, other accounts or durable session validity follows from one accepted request. Credentials were kept out of repository files and logs.
