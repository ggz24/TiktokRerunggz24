# Boxphone in local Live Hub

The `Boxphone` menu integrates the complete supplied Boxphone Lab v2 UI through an authenticated same-origin frame. The vendored source lives in `tools/boxphone-lab`; the original Desktop project is unchanged. All existing device selection/labels/screenshots, keyboard checks/setup, coordinate detection/picking/per-device coordinates, manual typing/direct sends, distinct-device drafts, AI providers/models, audio file/microphone/tab transcription, continuous listening/generation, real-only queue sending, cancellation, duplicate/rate controls, evidence views and JSON export are retained.

## Start

1. Start local Live Hub with Docker Compose.
2. Connect the phones to Xiaowei/ADB on this Windows computer.
3. Open `Start-Boxphone.cmd` in the Live Hub repository. It starts a hidden Node process on **127.0.0.1:8767**, creates a private bridge token in ignored `.env`, and opens `http://localhost:3100/boxphone`.
4. On first setup, rebuild the web image and apply its new environment: `docker compose build web` then `docker compose up -d --no-deps web`. Subsequent launches use the existing token.

ADB defaults to `C:\Program Files (x86)\xiaowei\tools\adb.exe`. Set `BOXPHONE_ADB` in `.env` to override it. ADBKeyBoard must already be installed on phones for Unicode typing; the integration does not install APKs or change keyboard settings on startup. Use the original keyboard controls when needed. No real phone input, AI call, or comment is sent by opening the page: real sending starts only after the user explicitly presses Start.

## Operation

The UI is inside Live Hub and uses its purple/cyan/pink palette. The Windows bridge stays local; Docker reaches it through `host.docker.internal`. Only the authenticated Live Hub administrator can load the view or forward fixed allowed actions. The bridge requires a secret header and rejects cross-origin requests. No ADB port is published. The browser never receives the bridge token. Saved API keys are encrypted on the Windows bridge per Live Hub user; they are not stored in Git or localStorage. Device labels and coordinate preferences use browser localStorage as before.

Keep this page open while recording audio or running the queue. Leaving/reloading stops the page's queue and recording; saved API keys remain available on the bridge, while unsaved input is cleared. A command already handed to a phone may still complete. Audio capture still depends on browser support and permission. An ADB send attempt does not prove viewer-visible delivery; preserve the original evidence and uncertain-result handling.

Production Compose intentionally does not enable this feature. This implementation targets localhost on the computer connected to the phones. VM remote pairing would require a separate authenticated outbound connector.

## Library videos and phone/channel assignments

The audio section now defaults to the authenticated Live Hub video library. Select a ready video, choose a start offset and a 5–60 second segment, and click the library transcription button. The internal API validates ownership and readiness, then extracts a small mono MP3 with FFmpeg; it never downloads or uploads the whole MP4 to the AI service. Local audio upload, microphone and tab capture are still available in the source selector.

Select phones, then assign each phone to an owned verified account in **โทรศัพท์ → ช่อง LIVE**. Assignments are saved in this browser per Live Hub user; Boxphone API keys and model preferences are saved on the authenticated Windows bridge per Live Hub user. Multiple phones can share one channel. The catalogue shows each channel's stream/video and existing AI reply readiness, with a link to Comments settings. Configure and enable the host's AI responder there. Boxphone does not silently enable a responder without its knowledge/key configuration.

**เริ่มถามอัตโนมัติตามช่อง** reads a recent 30 second audio window from each assigned channel's current rerun, estimates its position from stream start time (including video looping and an 8 second playback allowance), generates questions per channel, and rotates eligible phones. This is an estimate of the local FFmpeg timeline, not a measurement of viewer playback latency or of the host AI's replies. The first played window must be available before generation begins. Question history/deduplication is scoped to each channel. Sending opens/verifies the assigned TikTok LIVE before typing. The global 30 second and per-phone 120 second send gaps remain enforced.

Channel routing first checks the current room. It can otherwise use Android's scoped VIEW intent to the channel LIVE URL ([Android ADB reference](https://developer.android.com/tools/adb#am)). An intent opening successfully alone is not proof of the correct room. If the link opens the feed on a phone, enter the intended LIVE manually and use **ตรวจห้องที่เปิดอยู่**; this action never launches a URL.

For the observed TikTok Android build that shows only a host display name, the bridge recognizes the LIVE host header and composer, opens that header's profile card, reads the exact canonical handle from the card, dismisses the card, and requires the restored room header to match the verified display name and package. It repeats canonical profile verification before each send. While the focused LIVE composer hides the host header, it accepts only the observed LIVE modal/editor/send resources in the verified package within 30 seconds of that verification. It also requires the exact requested text in the focused editor and resolves the current send button. It never treats an account alias or a matching viewer comment as proof. A draft matching the requested text can be resumed after verifying the room again; a different draft is left untouched. Unsupported or ambiguous accessibility layouts stop sending. Queue items capture account, stream start, room and video identity. Reassignment, restart, offline channel, lost control service, or late AI results after Stop invalidate/cancel work. Real send results still require the existing delivery evidence checks.

UI inspection requires a successful fresh `uiautomator dump` result before reading its XML. Some Android versions report a failed dump with exit code zero; the bridge rejects that result so a previous screen cannot authorize a send.

## Accurate composer detection

The default send path reads each phone's current accessibility tree and requires two consecutive matching observations of a recognized TikTok LIVE input. It opens only that input, checks the focused editor again, types once, then verifies the exact text and a unique current send button twice before tapping. Saved/manual coordinates and screen-size guesses cannot authorize input or send actions. Unknown app layouts, search fields, profile overlays, duplicate inputs/buttons, incomplete dumps and moving targets stop the operation. A send with uncertain delivery is never retried automatically.

Each UI read uses a unique temporary XML filename, checks the dump's success message and complete XML, and removes that file. Transient failures retry the read only. Detection does not use a stale shared file from another request.

Choose one phone and press **ตรวจช่องพิมพ์ (ไม่ส่ง)** to open and verify its input without entering text or posting. The preview highlights the input in green and an available send button in pink. TikTok may leave the send icon non-clickable until text is entered; in that case, the send target is verified during the actual send. Queue sends perform the same detection separately per phone. Manual coordinates remain available for comparing screenshots.

Verification on 2026-10-06: fresh detection succeeded on Xiaowei #42, #47 and #57. The no-send preparation endpoint confirmed the focused input on #42. No comments or paid AI calls were made for this locator verification. Unit tests cover ambiguous/moved/foreign inputs, inactive send icons, stale/failed dumps and preparation without sends; the browser test covers the preview and one-phone selection. This is stricter detection, not a guarantee across every TikTok version.

Keep the Boxphone page open for automatic questions. This does not start a host LIVE or sign phones into TikTok. The host's LIVE and AI responder run separately in Live Hub. Local bridge changes require restarting `Start-Boxphone.cmd`; new API/web builds require updating those two Docker services while no stream is running.

## Tests

`node --test tools/boxphone-lab/*.test.mjs` runs the original program's queue/policy/delivery tests. Check logged-out access is rejected, cross-origin POSTs are rejected, local bridge authentication is required, device discovery works, and opening the page causes no device input. Test actual typing/sending with an authorized phone and intended LIVE separately.

`apps/api/src/boxphone-audio.test.ts` covers extraction boundaries and owner checks. `tools/boxphone-lab/livehub.browser-test.mjs` uses a fresh headless Chrome with mocked phones/channels/AI (no live comments or AI charges). Set `BOXPHONE_TEST_PLAYWRIGHT` to an available Playwright module when it is outside this workspace's dependency tree. It checks library selection, different channel assignments, target snapshot forwarding, real-only UI, reassignment cancellation and stop during generation.

### Local device verification — 6 October 2026

Twenty Android devices were discovered; one SM-G950F was tested in the actual `@pimnatcha66` LIVE. Its public LIVE link initially opened the feed, so the user entered the room manually. The native host profile flow verified the exact handle. The phone sent `ไฟเบอร์รี่ราคาเท่าไหร่คะ`; the bridge observed the new local comment, the host AI recorded a non-preview reply with status `sent`, and the phone's subsequent screenshot/accessibility nodes showed the host reply `ราคาจริงหน้าไลฟ์มีโปรพิเศษ กดตะกร้าดูราคาล่าสุดได้เลยครับ!`. In that initial single-phone test no comments were sent from the other nineteen devices. Actual automatic transcription/question generation still requires the Boxphone API keys in the page; that browser workflow was verified with mock AI responses rather than a paid end-to-end generation run.

## Find a phone

The device list reads Xiaowei device numbers/names from its local IndexedDB on the Windows bridge, joins by the exact ADB serial, and sorts by the Xiaowei number. It never assigns numbers based on ADB list order. Search accepts number, name, model or serial. Find Phone opens the number, serial and a fresh read-only screenshot; Refresh Image captures again. A web nickname is saved per signed-in user in the browser and does not rename the phone in Xiaowei. Missing/unsupported Xiaowei data displays no guessed number; screenshots and serials still work. Local device records only are returned; cookies and account credentials are not read.

Verified locally: all 20 connected phones map to Xiaowei #40–#59; three of them (#42, #47 and #57) were used for the live tests. Parser tests cover renumbering, deleted/conflicting records, CRC/truncated WAL records and Snappy copies. Browser checks cover finding #57, exact screenshot serial, name persistence, and no sending on page load.

### Three-phone LIVE verification — 6 October 2026

With Xiaowei #42, #47 and #57 simultaneously inside @pimnatcha66, one distinct product question was sent from each phone through the authenticated Boxphone send endpoint. Sends retained the 30 second global gap. All three returned observed_local, all three host AI history entries were non-preview sent, and fresh accessibility dumps plus screenshots on each sending phone showed its host reply. #42 asked about Fiberry sachet count (reply: 30); #47 asked about free shipping (reply referred to current cart promotions); #57 asked about Pinenee flavour (reply: tropical fruit). These were manually supplied test questions; paid automatic question generation from video audio was not exercised. Safe result metadata and screenshots are in ignored work/boxphone-three-real-results.json and work/boxphone-{42,47,57}-reply.png.

#47 required ADBKeyboard installation. Its APK matched SHA-256 of the original Boxphone APK and the already working #42 installation. The bridge keyboard discovery now uses ime list -a -s so an installed but disabled input method is correctly detected and enabled on an explicit send rather than falsely reported as missing. No input method is changed by loading the page. The three-message test has finished; no additional automatic sending was started.

## Saved Boxphone AI credentials (superseded)

> Keys are now saved encrypted on the server (see "Hosted site" below), so any computer works. The bridge-side encrypted file described here is no longer used for the page; the section is kept for history.

The integrated AI connection form saves on field change/blur or the Save Keys button. Transcription uses a separate OpenAI key; question generation keeps distinct OpenAI and OpenRouter keys. Provider and per-provider model preferences persist. Blank fields reuse saved keys, and API responses return presence flags and model preferences only. Keys are never returned to the browser, stored in localStorage, or included in exports. Delete Saved Keys stops automation and deletes the encrypted file for the current Live Hub user. Standalone mode retains in-memory keys only.

Credentials use AES-256-GCM with ACCOUNT_ENCRYPTION_KEY and authenticated data bound to the owner and Boxphone purpose. Files live outside the repository/Docker image at %LOCALAPPDATA%/LiveHub/Boxphone/credentials (or BOXPHONE_CREDENTIAL_DIR). Filenames hash the owner; writes are atomic and serialized per owner. Preserve this directory and the application encryption key for backup. The web proxy supplies the owner from the authenticated session, never from request body/header values. The bridge requires its authentication token before accepting owner-scoped storage requests. Saved keys are resolved only inside the bridge when calling the chosen AI provider. No LIVE/API service restart is needed for this local feature.

Tests cover encrypted persistence across restart, metadata without key values, owner/AAD isolation, deletion, concurrent partial saves, blank-field preservation, invalid input, provider switching, model persistence, reload with empty password fields, saved-key use for transcription/questions, and absence of key values in localStorage. Local integration checks use synthetic credentials in an isolated temporary owner and delete them afterward; they do not call paid AI services.

## Whole-clip question plan (saves tokens)

In the audio section, choose a library video and press **ให้ AI ฟังทั้งคลิปแล้ววางแผนคำถาม**. Every 60 s window of the clip is transcribed once with `gpt-4o-mini-transcribe` (finished windows are kept in this browser, so a stopped run resumes without paying again). The whole timestamped transcript is then sent in one OpenAI Responses request (default model `gpt-4.1-mini`, long context and low price; if the account cannot use it the saved question model is used) which returns questions with the clip time to ask them. The plan is editable as `m:ss | question` lines and saved per Live Hub user and video in this browser.

Tick **ใช้แผนนี้ตอนกด "เริ่มถามอัตโนมัติตามช่อง"** to use it. During a LIVE the channel loop only reads the stream's start time, works out the looping clip position (with the existing 8 s playback allowance) and sends the questions that have come due and are not older than 5 minutes. No transcription or question-generation request is made per round, and an AI key is not needed to run a saved plan. A question is used at most once per stream and loop; the 30 s global and 120 s per-phone gaps, duplicate checks, host verification and real-only sending are unchanged. The position is an estimate of the local FFmpeg timeline, not a measurement of viewer-side playback. The plan uses OpenAI only. `node --test tools/boxphone-lab/plan.test.mjs tools/boxphone-lab/plan-ai.test.mjs` covers timing, normalisation, model fallback and malformed answers.

## Hosted site (ggz24.com/live): any computer, no manual setup

The hosted site cannot reach phones plugged into a Windows computer, so each computer connects OUT to it and nothing is opened inbound.

**Pairing.** In the hosted Boxphone page press "create pairing code". The server stores only a hash of the 8-character one-time code (10 minutes) and shows the code with a download of `Boxphone-Setup.cmd`. Double-clicking that file runs `tools/boxphone-lab/installer/setup.ps1`, which downloads a portable Node (served from the site, checked against nodejs.org's SHA-256 list at image build) and the connector files (each checked against a SHA-256 manifest), finds Xiaowei's ADB, trades the code for this computer's own token (`/api/boxphone-agent/pair`), saves `config.json` in `%LOCALAPPDATA%\LiveHubBoxphone` (ACL limited to the current user), adds a Startup shortcut and starts the connector. The connector (`agent.mjs`) long-polls `/api/boxphone-agent/next` with that token, runs only the fixed Boxphone actions against the local bridge, and posts results back; the bridge token never leaves the computer. Computers can be removed in the page; their tokens stop working at once (cached for at most 60 s).

**Several computers at once.** `apps/web/lib/boxphone-relay.ts` keeps one queue per computer. `devices` asks every online computer and merges the lists, tagging each phone with its computer; every other phone action goes to the computer that reported that serial. The relay lives in the web service's memory, so it must run as a single replica; a request the computer does not answer within 125 s fails, and a computer that has not polled for 45 s counts as offline. A server-wide `BOXPHONE_AGENT_TOKEN` (older single-computer setup) still works as one computer called "คอมเครื่องหลัก".

**AI runs on the server.** OpenAI/OpenRouter keys are saved encrypted in the database (AES-256-GCM, bound to the signed-in user) in the page's "AI connection" section, so any computer works and nothing is re-entered. Transcription, question generation and whole-clip plans all run in the API (`apps/api/src/boxphone*.ts`). Each key kind has up to three **backup keys**: when the main key is rejected (invalid, forbidden or out of quota/rate limit) the next one is tried automatically; other errors do not trigger a switch. The computers only control phones.

Server `.env.production`: `BOXPHONE_ENABLED=true`, `BOXPHONE_REMOTE=agent`. Anyone who can sign in to the hosted site can send comments through paired phones, so keep the site's password strong. Tests: `node --test "tools/boxphone-lab/*.test.mjs"`, `npx tsx --test apps/web/lib/boxphone-relay.test.ts`, and `apps/api/src/boxphone.test.ts` in the API suite. Setting `BOXPHONE_SETUP_ROOT` and `BOXPHONE_SETUP_DRYRUN` lets the installer run into a temporary folder without autostart.