# Plan: Fix scroll hitching when cards load into the viewport (scroll-up)

**Date:** 2026-10-29
**Symptom:** The desktop chat hitches when scrolling up while older message cards are loading into the viewport. Scrolling up is the dominant affected direction.

**Source analyzed:**
- `%APPDATA%\goose\logs\scroll-perf.log` (written 2026-10-29 16:00 — current)
- `ui/desktop/src/components/MessageList.tsx` (`VirtualMessageList`, history hydration)
- `ui/desktop/src/utils/smoothScroll.ts`, `ui/desktop/src/utils/scrollPerf.ts`
- `ui/desktop/src/main.ts` (console → `logs/scroll-perf.log` relay)

Stale files explicitly excluded: `logs/main.old.log` (Oct 28).

---

## Evidence from the current log

Parsed 52 `[scrollPerf] DUMP` buffers, 17,137 events, 5 session boots.

| Signal | Measurement |
|---|---|
| Long tasks (main thread >50ms) | **1,565 total; 130.6s of blocked main thread**; p50 **82ms**, p90 **112ms**, p99 146ms, max 403ms |
| Long frames (>50ms dt) | 1,229 logged: p50 **94ms**, p90 **130ms** → roughly **7–10 FPS** during bad windows |
| Hydration queue (`batch-queue remaining`) | Drains **one card per cycle**; per-cycle gap p50 **99ms**, p90 **147ms**; queue reached **486 cards** → ~45s+ continuous saturation |
| Wheel direction jank correlation | **932 / 1,565 long tasks within 0.8s of an *up-wheel*** (vs 205 near down-wheel); 515 up vs 160 down wheel ticks |
| Batch pin overhead | Each one-card hydrate triggers `jump` + `live-pin` + `batch-commit`; each pin re-reads `scrollHeight` (forced sync layout) and calls `cancelWheelSmoothing` |

Caveats / re-baseline note:

- The **running binary is older than the working tree**: the log contains `wheel-up-escape` and no per-event context merge; the working tree has neither/has `HISTORY_BATCH=6` instead of the logged one-card drain. Rebuild (`pnpm run package`, see `Build Notes.txt`) before treating constants as current.
- Context attribution (`streaming`/`hydrating` fields) is absent in the deployed build's events, so streaming-vs-hydrating split is unproven; wheel-proximity stats are unaffected.

---

## Root causes (scroll-up specific)

1. **Mount cost ≫ scheduler cadence.** Hydrate tick runs every `HISTORY_BATCH_MS=32ms`, but a one-card reveal costs ~80–150ms (React mount of `GooseMessage` markdown/tool/code trees plus forced-layout read in the pin path). The main thread becomes a continuous train of long tasks for tens of seconds; no batch ever fits inside a frame.
2. **The wheel is hijacked during hydration.** `blockWhileLoading` runs `preventDefault()` + `pinToEnd()` on every wheel event while `loadingHistoryRef` is set, and `scrollViewportTo`/`pinToEnd` kill the wheel glide (`cancelWheelSmoothing`). Up-scroll attempts during card mount are swallowed and the viewport snaps back to the bottom → perceived hitching.
3. **No `content-visibility`.** The list keeps every card in document flow by design. Rows do have `contain: layout`, but cards entering the viewport from above still pay full style+layout+paint on first encounter — matching the 90–130ms frames right at up-wheel ticks (including after settle).
4. **Double scroll compensation.** Manual pin-to-bottom in `useLayoutEffect` (`jump` + `live-pin`) *and* native `overflowAnchor: auto` on the list both react to prepends; they fight, adding jitter. The scroll handler's `read()` also calls `pinToEnd()` per scroll event during hydration (layout thrash: multiple `scrollHeight` reads/writes per tick).

---

## Solutions (prioritized by impact / effort)

### 1. `content-visibility` on rows — biggest single win
On each `MessageRow` wrapper (already has `contain: layout`) add:

```css
content-visibility: auto;
contain-intrinsic-size: auto 160px; /* tune to median card height */
```

Off-screen cards skip style/layout/paint; hydration reveals and scroll-up re-encounters become near-free. Keep scrollbar stability with the intrinsic-size placeholder. Tune the placeholder so scrollbar length doesn't jump.

### 2. Budget-driven hydration scheduler
Replace the fixed `HISTORY_BATCH_MS` timeout with adaptive, interaction-aware scheduling:

- Measure each batch's true cost (the instrumentation already logs `batch-queue` → `batch-commit sinceQueuedMs`).
- Adapt batch size so a batch stays ≤ ~10ms of main thread; skip a tick when the last batch overran.
- **Pause the queue while the user is actively scrolling (especially up) or mid-glide;** resume after ~200ms of quiet.
- Consider `requestIdleCallback` (or `scheduler.yield()`) instead of fixed `setTimeout`.

Do not blindly drain to 0 while the user is interacting. Note: if per-card cost stays ~100ms, the current tree's `HISTORY_BATCH=6` would create one ~600ms hitch — the scheduler fix matters more than raising batch size.

### 3. Stop hijacking the wheel during hydration
- Remove `preventDefault()` + `pinToEnd` from the wheel path while hydrating (or restrict it to the very first paint only).
- Keep the live edge via the layout-pin / anchoring only when actually following.
- Only cancel wheel smoothing when a *real* programmatic jump happens, not on every scroll event.

### 4. One scroll-compensation strategy, not two
Choose either:
- **Native anchoring:** keep `overflowAnchor: auto` and do *not* manually pin during prepends; or
- **Manual pin only:** set `overflowAnchor: none` on rows and pin explicitly.

If manual: compute `delta = newHeight − oldHeight; scrollTop += delta`, reading layout once **before** mutating DOM instead of re-reading `scrollHeight` after each commit.

### 5. Cheaper per-card mount
- Replace `memo(MessageRow, isEqual)` (deep lodash compare per row per render) with version-key memoization (message id + updatedAt).
- Images: `loading="lazy"`, `decoding="async"`.
- Defer/throttle markdown re-parse and syntax highlighting (idle deferral or worker). This also attacks the recurring ~50–110ms long tasks observed while streaming.

### 6. Streaming render cost (secondary)
- Keep the prefix rows frozen while streaming (already implemented via `historyLock`).
- Consider throttling markdown flushes during streaming (e.g., re-render markdown every 50–100ms instead of per token) to reduce the recurring long tasks that hitches ride on.

### 7. Re-baseline + re-verify
- Rebuild the package so the working tree constants are what's measured (`pnpm run package` per `Build Notes.txt`).
- Instrument per-batch breakdown if needed: `performance.mark()` around mount vs layout-effect pin to separate React mount cost from forced layout.

**Success criteria (repeat the same session repro):**
- Frame dt **p95 < ~33ms** while scrolling up,
- Hydration long-task total ≪ current 130s (target: order of seconds),
- No wheel `preventDefault` during hydration,
- No visible scrollbar reflow jumps (intrinsic-size tuned).

---

## Status: items 1–3 implemented (2026-10-29)

Files touched: `ui/desktop/src/components/MessageList.tsx`, `ui/desktop/src/utils/scrollPerf.ts`, `ui/desktop/src/utils/smoothScroll.ts`, `ui/desktop/eslint.config.js`.

- **1. content-visibility** — both `MessageRow` wrappers got `contentVisibility: 'auto'` + `containIntrinsicSize: 'auto 160px'` (alongside existing `contain: 'layout'`); the transcript-search path forces full layout before measuring (`row.style.contentVisibility = 'visible'`) in both list variants.
- **2. Budget-driven scheduler** — fixed `HISTORY_BATCH`/`HISTORY_BATCH_MS` replaced by an adaptive loop: batch size (1–8) is derived from the measured cost of the last batch (`batch-commit sinceQueuedMs` / per card, target ≤ 10ms); batches that overran 96ms are skipped up to 2 ticks, then mount one card. While the user is detached and mid-list, draining pauses until 200ms of scroll quiet (our own pin echoes don't count as user input); near the hydration frontier (within 2 viewports of the top) the queue keeps mounting so scroll-up never dead-ends.
- **3. Wheel hijack removed** — `blockWhileLoading` (`preventDefault` + `pinToEnd` on every wheel event) deleted; during hydration the bottom pin only applies while the user is still following the live edge, so scrolling up now moves freely while older cards mount.

Also: prettier pass over the three files; empty `catch` in `scrollPerf.ts` commented (eslint `no-empty`); missing browser globals (`performance`, `WheelEvent`, `PerformanceObserver`, `IntersectionObserver`) added to `eslint.config.js` (these were already used by committed code — `no-undef` lint failures were pre-existing).

Checks: typecheck clean (the 2 pre-existing `questionnaireSchema.ts` TS6133 errors were also removed: dead `optionOfTitle` helper deleted, unused callback param renamed `_question`), eslint clean on scope files, prettier clean, related unit tests 21/21 + questionnaireSchema tests 12/12 (jsdom bypasses hydration, so step 7's rebuild + session repro is still required for perf validation). Items 4–7 remain open.

## Status: items 4–6 implemented (2026-10-29)

- **4. Single scroll-compensation strategy** — chose *native scroll anchoring + follow pin*: the per-scroll-event `pinToEnd()` during hydration is deleted (along with its `pin` perf log), so while following, bottom position is set once per batch commit in the layout effect, and native anchoring keeps detached users stable while batches/`content-visibility` expansions shift geometry above them. Scrolling up mid-hydration now only detaches (no more forced re-pin per scroll tick).
- **5. Cheaper per-card mounts** — `MessageRow` memo now uses `areMessageRowPropsEqual`: scalar fields first, then per-field reference short-circuits falling back to the existing deep `isEqual` per field (identical semantics, skips the deep walk of unchanged settled rows). Message-path images (`ImagePreview`, used by user + goose cards, and tool-result images in `ToolCallWithResponse`) render with `loading="lazy"` and `decoding="async"`.
- **6. Streaming cost** — markdown flush cooldown raised 50ms → 100ms (`STREAMING_RENDER_COOLDOWN_MS`); the 250ms large-message (>16k chars) cooldown is unchanged. The prefix rows were already frozen during streaming via `historyLock`. Deferred/worker syntax highlighting remains open (see below).

Checks: typecheck clean, eslint + prettier clean on scope files, tests 38/38 (MessageList, ProgressiveMessageList, useThrottledStreamingText, questionnaireSchema). Still open: item 7 rebuild + session repro for perf numbers; deeper highlight deferral/worker for streaming code blocks (CodeBlock currently re-highlights whole blocks on every markdown flush).

## Status: loading UX changed per user decision (2026-10-29 16:40) — supersedes item 3's "no wheel hijack"

- **Loading lock**: while `loadingHistory` (hydration until settled), a `data-chat-hydrating="true"` attribute is set on the chat's scroll-area root; `main.css` then locks the viewport (`overflow-y: hidden !important`) and hides the Radix scrollbar (`display: none !important`), and a `blockWhileHydrating` wheel listener re-prevents wheel input. Position stays glued to the live edge via the existing follow pin, so reveal lands at the bottom.
- **Single loader**: the rows are `visibility: hidden` while hydrating (they still mount/lay out — the budget scheduler keeps them cheap) so **no cards show until the chat is loaded**; one centered sticky `LoadingGoose` pill (`bottom: 38%`, `visibility: visible` override) replaces the old bottom pill. The pill is suppressed while `isStreamingMessage` is true, when BaseChat's own bottom-left `LoadingGoose` covers the state — exactly one loading animation visible in all combinations. `BatchedMessageList` (≤50-message chats) got the same hidden-rows + one-pill treatment (no scroll lock: its drain is ≤~200ms).

## Status: Q1 streaming fix — per-block incremental renderer (2026-10-29 16:50)

User rejected any look-and-feel change during streaming (no plain-text preview). Chosen fix keeps full formatted rendering and only relocates the work:

- **`utils/markdownBlocks.ts`** — new `splitMarkdownBlocks`: blank-line split that is fence-aware (never splits inside ``` fences, unterminated trailing fence stays one block) and merges loose list/quote islands + indented continuations back together, so ordered numbering and nested structures survive. 10 unit tests in `markdownBlocks.test.ts` (all passing).
- **`MarkdownContent.tsx`** — existing renderer extracted into memoized `MarkdownPipeline` (same react-markdown, plugins, and `a`/`code` components — copy buttons/external links untouched); `MarkdownContent` now wraps it; new exported `StreamingMarkdownContent` renders the split blocks per segment, re-parsing only the growing tail block per flush and reusing verbatim elements for finished ones.
- **`GooseMessage.tsx`** — the text-only streaming branch renders `StreamingMarkdownContent` for the throttled text; on completion it swaps to the canonical `MarkdownContent` (single full render, final content → highlight runs once).
- **CodeBlock** — per-render `console.log` removed; Prism input capped at 50k chars (beyond the cap a fenced block renders as plain monospace — applies almost exclusively while a giant block streams; re-evaluate after measuring).
- Flush instrumentation: `scrollPerfLog('markdown-flush', { chars, blocks })` per throttled flush for the item-7 rebuild validation.

Checks: typecheck 0 errors; eslint + prettier clean on the new/rewritten files; vitest 48/48 scoped suites. Full suite: 1055 passed / 8 failed / 19 skipped — verified pre-existing or flaky (run-to-run flip; recipe-validation ×4, chatSessionStore steer ×1, CustomProviderForm credentials ×1 fail at HEAD too; ExtensionModal/CustomProviderForm secrets flip pass/fail across identical runs — unrelated files, no imports from this workstream).

Open items: Q2 content-hash LRU (approved, not yet built), Q3 idle pre-warm (approved, not yet built), Q4 tool-output cap (approved, not yet built), item 7 rebuild + real-session repro.

## Status: Q3 + Q4 applied, Q2 partially applied (2026-10-29 17:20)

**Incident + recovery:** while patching Q3 into `MessageList.tsx`, an interrupted PowerShell edit-runner was written over the file's content (disk copy became the script text). The last good working tree (960-line `MessageList.tsx` with items 1–6 + loading UX + streaming work) was recovered byte-identical from the dropped stash commit `c5967819b` ("On main: validate-head-scrollwork", 16:59:51) via `git show c5967819b:...` (hash-verified `27e298c4`). All other touched files were unaffected.

- **Q4 tool-output cap** — `ToolCallWithResponse.tsx`: `TOOL_OUTPUT_MAX_LINES = 200`; longer results render 200 lines + "Show full output (N lines)" expander (`toolCallWithResponse.showFullOutput` i18n); tool-result images get `loading="lazy"` + `decoding="async"`.
- **Q3 idle pre-warm** — `MessageList.tsx`: rows register their wrapper with an `IntersectionObserver` (root = the chat viewport, `rootMargin: '200% 0px'`); near-viewport rows are queued via `requestIdleCallback` (fallback timer) and revealed in chunks of ≤6 (`contentVisibility: visible`) so the first real style/layout happens during idle time instead of mid-scroll. Disabled when `prefersInstantScroll()`. Effect re-created per `sessionId`.
- **Q2 content-hash LRU (partial)** — new `utils/markdownCache.ts` (cyrb53 `hashString` + byte-budgeted `LruCache` that always keeps the newest entry), 8 unit tests. Wired into `CodeBlock` (`MarkdownContent.tsx`): the highlighted markup is captured once (`useLayoutEffect` reads the rendered container) keyed by `hash(language\u0000code)`; any later mount of the same code — i.e. returning to the chat after a session switch, the main non-cached hit — renders verbatim via `dangerouslySetInnerHTML` and never re-runs the highlighter. Interactivity is preserved because the copy button lives outside the cached subtree; streaming tail blocks still highlight live per flush (cache key tracks content). 2 RTL tests cover capture-once/reuse-on-remount and distinct-content misses.
- **Q2 remainder (decision needed):** markdown *parse* work (remark/rehype incl. rehypeKatex per card) still re-runs on switch-back remounts. Full remedy = keep-alive: either per-session hidden mounted lists (real zero-remount, ~neutral memory thanks to `content-visibility`) or a persistent offscreen React root portal-ing into rows. Larger blast radius — confirm before building.
- Checks: typecheck clean; eslint + prettier clean on all scope files; vitest scoped suites 84/84 (incl. the 10 new cache tests). Still open: item 7 rebuild + real-session repro; Q2 remainder decision.

## Status: loader position reverted per user decision (2026-10-29 17:36) — supersedes the centered pill

User decision from screenshots: keep the **original** loading pill position **near the input box** and remove the relocated centered pill; keep the "no cards until the chat is loaded" gating.

- `MessageList.tsx` VirtualMessageList pill: `bottom: '38%'` → `bottom: 8` (the HEAD/original position, right above the input area). Text unchanged (`messageList.loadingHistory` — "Chat is loading" was already HEAD's string). The `!isStreamingMessage` suppression stays, so BaseChat's own bottom-left `LoadingGoose` (visible for every non-idle `chatState`) and the list pill never show together.
- `BatchedMessageList` loader: reverted to HEAD's original non-sticky centered block (`flex flex-col items-center justify-center py-8`); its rows-hidden-while-`isLoading` gating was kept.
- Unchanged on purpose: `data-chat-hydrating` scroll-lock CSS, hidden rows until hydration completes, single-loader suppression, and everything else in this workstream (content-visibility, adaptive scheduler, pre-warm, tool-output cap, highlight cache).
- Checks re-run: typecheck, eslint, prettier clean; vitest scoped suites 84/84.
- Rebuild + measure (item 7) proceeds: cargo release build ✓ (46s, fresh `goose.exe` copied to `ui/desktop/src/bin`, unlink-first), `pnpm run package` next; measured repro will run the fresh package from `out-build` with an isolated Electron profile + CDP harness (the live installed app keeps running untouched during the swap).
- Q2 remainder decision (per-session keep-alive vs. stop) stays pending until numbers are in.

## Root cause: package script killed the running app (2026-10-29 17:47) — fixed

`scripts/prepare-package-output.js` (first step of `pnpm run package`/`make`) had `stopGooseLockers()` running `taskkill /F /IM Goose.exe /T` unconditionally — every rebuild force-killed **every** running Goose instance and its process tree (including the goosed backend child). This closed the user's live app during rebuild attempts.

**Fix:** the script now queries `Win32_Process` for `Goose.exe` processes and stops only those whose executable path is under `ui/desktop/out*` (instances actually holding the packaged output). Installed copies (e.g. `C:\Home\Tools\Goose`) and dev CLI processes are never matched. Verified live: script ran its full prep (`Packaging to out/Goose-win32-x64`) with Goose open and the app survived.

**Standing rules from the user:** never issue any command that closes/kills/restarts the app, and never run a rebuild without explicit approval — each rebuild is triggered by the user (or an explicit per-command go-ahead).

## Status: single session loader (2026-10-29 17:53)

User decision: the near-input `LoadingGoose` pill is THE session loader; the message list no longer renders its own.

- `MessageList.tsx`: both pills removed (the virtual `bottom: 8` overlay and the batched centered block). New optional prop `onLoadingHistoryChange(loading)` reports hydration / batched-drain state from both variants. Removed the now-unused `LoadingGoose`/`ChatState` imports, the batched `intl`, and the `loadingHistory`/`loadingMessages` defineMessages entries (the `progressiveMessageList.loadingMessages` key itself stays — `ProgressiveMessageList` owns it); dropped `messageList.loadingHistory` from `en.json`.
- `BaseChat.tsx`: local `historyLoading` state fed by the callback; the bottom-left pill now renders while `chatState !== ChatState.Idle || historyLoading`, presenting `ChatState.LoadingConversation` (LoadingGoose's own "loading conversation..." label) during idle-but-hydrating loads, without touching the chat-state machine. A `messages.length === 0` reset guards against an empty view sticking the pill.
- Unchanged: rows-hidden gating until the chat is loaded, `data-chat-hydrating` scroll lock, the single-loader suppression semantics, and the "Loading model..." footer chip on the input card (part of the desired look from the user's references).
- Checks: prettier/eslint/typecheck clean; scoped vitest 84/84; full suite 1065 passed / 8 failed / 19+2 skipped — the 8 match the pre-existing/flaky set recorded at 16:50 (recipe validation ×4, chatSessionStore steer ×1, CustomProviderForm credentials flapping ×3 this run; unrelated files).
- To see it live, the deployed app still needs a re-package + swap into `C:\Home\Tools\Goose` — user-triggered only.
## Status: no scrollbar / down-arrow flash during load + percent on pill (2026-10-29 18:00)

User request: while a session loads, hide the scrollbar and the scroll-down arrow button, and add a progress percentage to the single near-input loading pill.

- `MessageList.tsx`: renamed the prop to `onHydrationProgress?: (progress: number | null) => void`. `VirtualMessageList` emits `1 - historyStart / initialStart`, clamped to [0,1], while `loadingHistory` with a positive `initialStart`, else null; `BatchedMessageList` emits `renderedCount / messages.length` while draining, else null; both emit null in cleanup on unmount/deps change.
- `BatchedMessageList` now sets the `data-chat-hydrating` attribute on its scroll-area root (same effect as virtual), so the existing `main.css` rules (viewport `overflow-y: hidden !important`, scrollbar `display: none !important`) now cover short chats too — the flash in the user's screenshot was the batched variant missing this.
- `BaseChat.tsx`: replaced the boolean with `historyProgress: number | null` (`historyLoading = historyProgress !== null`). Pill message becomes `loading conversation... {rounded percent}%` (new `baseChat.loadingConversationProgress` key) whenever hydration is in progress, falling back to `progressMessage` otherwise. The scroll-down arrow is additionally gated on `!historyLoading && chatState !== ChatState.LoadingConversation`.
- i18n: extracted, added the new key plus the previously missing `toolCallWithResponse.showFullOutput` to all 15 non-English locales, and removed stale `messageList.hiddenMessages` / `messageList.loadingHistory` / `messageList.showAllMessages` entries; `i18n:check` now passes for the first time this workstream (1611 messages).
- Checks: prettier clean, eslint `--max-warnings 0` clean on both components, typecheck clean, scoped vitest 84/84 (MessageList, ProgressiveMessageList, MarkdownContent, useThrottledStreamingText, markdownBlocks, markdownCache, questionnaireSchema).
- To see it live, the deployed app still needs a re-package + swap into `C:\Home\Tools\Goose` — user-triggered only.

## Status: scrollbar root cause, deferred highlighting, wheel released (2026-10-29 18:25)

User re-verified the 18:00 build: scrollbar still visible while the percent pill shows,
load takes too long, and scroll-up still hitches with a slight downward view shift.

- **Scrollbar (true root cause):** the deployed Radix "react-scroll-area" renders only
  the 'data-radix-scroll-area-viewport' attribute; there is no 'data-radix-scroll-area'
  marker on the Root and no 'data-radix-scroll-area-scrollbar' attribute at all. The
  previous closest('[data-radix-scroll-area]') lookup returned null, the attribute
  ended up on the inner content div, and the CSS hid a nonexistent attribute. Fix:
  ScrollAreaHandle now exposes rootRef (scroll-area.tsx); BaseChat owns
  'data-chat-hydrating' in a React.useLayoutEffect (before paint) keyed on
  chatState === LoadingConversation || historyProgress !== null; main.css hides the
  scrollbar structurally with
  [data-chat-hydrating='true'] > [data-orientation='vertical'] { display: none !important }.
  MessageList no longer sets the attribute (single owner).
- **Loading speed:** the fresh scroll-perf log showed ~100-150 ms longtask + frame per
  drain tick with batch size 1: every first-mount CodeBlock runs the Prism highlighter
  synchronously during render (the LRU only makes re-visits cheap). MarkdownContent now
  exports DeferHighlightContext; during hydration the whole row list is hidden anyway,
  so CodeBlock renders plain monospace and resolves highlights from a serial
  requestIdleCallback queue (one job per idle slot, 300 ms timeout, fallback timer in
  jsdom). Plain output is never cached. Adaptive drain retuned: HYDRATE_BUDGET_MS 10-24,
  batch max 8-16, retry 32-16 ms. Pre-warm band widened to +-400% viewport with chunks
  of 12.
- **Scroll-up hitch + downward view shift:** rows scrolled into view convert the 160px
  content-visibility estimate to a real height mid-gesture. The hydration wheel hijack
  (preventDefault) was removed - scrolling is allowed while loading and the
  ScrollArea anchor/ResizeObserver pin keeps the reading position stable while history
  cards mount above. Once hydrated (and not streaming), MessageList runs a background
  materialization pass that reveals every row real height in idle chunks of 24; with
  contain-intrinsic-size auto remembering measured heights, later scrolls no longer
  resize anything.
- eslint.config.js: added DOMRect to the globals allowlist (pre-existing no-undef
  failure in scroll-area.tsx surfaced when linting it this round; file prettier-formatted).
- Residual accepted trade-off: right after the pill disappears, code blocks can pop
  from monospace to highlighted for a few hundred ms while the idle queue drains; text
  and layout are identical in both states.
- Checks: prettier clean, eslint --max-warnings 0 clean (incl. scroll-area), typecheck
  clean, scoped vitest 86/86 (adds the deferred-highlight test).
- Still user-triggered: repackage + swap into C:\Home\Tools\Goose.

## Status: scroll-perf instrumentation removed (2026-10-29 20:03)

User decision: the debugging log served its purpose. Removed utils/scrollPerf.ts, all
call sites (MessageList session-init/batch-queue/batch-commit/live-pin/jump/
follow-off/follow-on/settled/reveal/materialize, smoothScroll wheel/glide-start/
glide-stop, MarkdownContent markdown-flush), and the console-to-file relay in main.ts
that wrote logs/scroll-perf.log. Behavior unchanged: the settle detection, adaptive
batch cost tracking, anchor pinning, and pre-warm/materialization all keep working.
If scroll issues need data again, re-add a similar rAF+longtask observer.

## Status: frame-drop pass (2026-10-29 20:22) — coalescing, compositor hints, read-free wheel path

User report after the 20:04 install: load hitching gone, but scrolling feels like it
drops frames. Code-path audit (no new instrumentation): during a wheel glide the
deployed build still ran the scroll handler pair (ScrollArea `handleScroll` +
VirtualMessageList `read`) directly per scroll event, and `attachWheelSmoothing`'s
wheel clamp read `scrollHeight` per wheel event — a read that forces any pending
content-visibility layout synchronously on the input path, the wheel-side variant of
the longtask pattern the instrumentation had already tied to up-wheels.

- scroll-area.tsx / MessageList.tsx: both scroll listeners coalesced to one run per
  rAF (handler runs only when the frame is painted anyway).
- smoothScroll.ts: the wheel path no longer reads geometry. Mid-glide events only
  advance the glide target; the ceiling clamp moved into the glide step (one
  scrollHeight read per frame, where a read already happens). `WHEEL_TAU_S` untouched.
- main.css + BaseChat.tsx: `chat-scroll-area` compositor hints — `will-change:
  scroll-position` on the radix viewport, `will-change: transform` on its content
  wrapper.
- Checks: typecheck clean; eslint --max-warnings 0 clean on MessageList,
  scroll-area, BaseChat, smoothScroll; vitest scoped 28/28 (smoothScroll 7,
  MessageList 7, messageWindow 14).
- **Not built yet:** these edits (20:12–20:21) postdate the installed app.asar
  (20:04:58), so the user's frame-drop report is against a build *without* them.
  Next step is a repackage + swap (user-triggered).

## Status: mid-turn scroll-up treadmill root cause + fix (2026-10-29 20:37)

User report after the rebuild: during a Thinking turn, scrolling up from the live
edge behaves as if the collapsed thinking block still occupies its expanded height.

**Mechanism.** The thinking content streams into a Radix collapsible that is closed
(display:none), so the streaming card's height is stable and small — there is no
phantom thinking height in the DOM. What "as if expanded" actually is: rows sit at
`content-visibility: auto` (160px retained estimate) until revealed by the idle
pre-warm pass or the idle materialize pass. The pre-warm reveal queues to
`requestIdleCallback`, which never fires mid-glide (main thread busy), and the
materialize pass was **suspended for the entire turn** by the `isStreamingMessage`
gate (thinking included). On a freshly started app with a turn in flight, everything
above the pre-warm band is unmaterialized; a scroll-up converts estimate→real height
mid-gesture — cards grow, content below shoves back down, and the remaining scroll
distance keeps inflating — scrolling through invisible expanding content, with the
same 50–100ms conversion long tasks as the report of dropped frames during scrolling.

**Fix (`MessageList.tsx`):**
- The materialize pass no longer suspends for the streaming turn: it runs whenever
  hydration has settled, in 4-row chunks while a turn is live and 24-row chunks
  otherwise (streaming state read via a ref at reveal time — the effect no longer
  restarts when the turn starts/ends, so a pass already in flight continues).
- The pre-warm observer reveals the nearest intersecting rows synchronously in the
  IO callback (≤12 per callback) instead of waiting for an idle slot the glide never
  provides; hydration (rows hidden) keeps using the idle queue.

Checks: typecheck clean; eslint `--max-warnings 0` clean on MessageList.tsx; scoped
vitest 28/28 (MessageList 7, messageWindow 14, smoothScroll 7). Needs a rebuild +
repackage to reach the installed app (user-triggered); `WHEEL_TAU_S` untouched.

## Status: integration tightening — all scroll pins defer to wheel glides (2026-10-29 23:41)

Post-GPU-diagnostic audit found the last integration gap: the virtual list's flush
pin, ScrollArea's ResizeObserver bottom-pin + drift correction, and the auto-scroll
effect still fired *while a wheel glide was in flight* — their guards track
ScrollArea's own smooth-scroll state, not the glide. At gesture start a streaming
flush could land first, cancel the glide via `cancelWheelSmoothing`, and eat the
first wheel tick.

- `smoothScroll.ts`: exported `isWheelGlideActive(element)`; the controller map now
  stores `{ stop, isAnimating }` (cancel paths unchanged).
- `MessageList.tsx` / `scroll-area.tsx`: the flush pin, the RO pin + drift
  corrections, and auto-scroll early-return while a glide is active (the glide is
  the user moving the view). Anchor re-capture resumes from the scroll-event
  debounce after the gesture ends.

Checks: eslint clean on all three, typecheck clean, scoped vitest 28/28. Requires a
rebuild to reach the installed app (user-triggered). Remaining known levers are feel
knobs, not integration gaps: WHEEL_TAU_S (kept at 0.2), the <2px instant-nudge
threshold, LINE_HEIGHT_PX (line-mode wheel delta), native-vs-glide for high-res
wheels (currently native pass-through). Chromium floor: during streaming + scroll,
one bounded forced layout flush per frame (inherent to main-thread-driven scroll);
true compositor-thread custom-curve scrolling would require a transform-based
synthetic scroller — not planned.

## Status: smoothness over long tool/code chains (2026-10-30 11:35)

User report: the jump-to-bottom bug is fixed, but scrolling remains rough when a
transcript has many small code/command blocks.

- **No per-frame `scrollHeight` read in the wheel glide.** `smoothScroll.ts` used
  to clamp the glide target against `scrollHeight` every animation frame. With
  pending content-visibility conversions that read forces synchronous layout on
  every glide frame. The clamp is gone: `scrollTop` writes are already clamped by
  the browser, and the glide now stops after two stalled frames at the ceiling.
  One read removed per frame on the input path.
- **Tool/command cards skip independently.** A single assistant turn can hold a
  long chain of tool calls, but the row-level `content-visibility: auto` only
  treated the whole row as one box. `main.css` now gives
  `.chat-history-settled .goose-message-tool` its own
  `content-visibility: auto` + `contain-intrinsic-size: auto 96px`, so offscreen
  cards are not laid out/painted when the row enters the pre-warm band.
- **Pre-warm no longer converts synchronously mid-gesture.** The IntersectionObserver
  used to reveal 2 rows per callback while the user was scrolling. Mid-gesture
  reveals are now queued to the idle pass only; rows actually entering the viewport
  are left to the browser. The band shrank from 400% to 200% viewports and idle
  chunks from up to 12 rows to 2-8, bounding each forced layout.
- Test: new `smoothScroll` case asserts a glide at the scroll ceiling stops without
  reading `scrollHeight` (getter throws if touched).
- Checks: typecheck clean; eslint clean; scoped vitest 66/66 (smoothScroll,
  MessageList, ProgressiveMessageList, scroll-area, MarkdownContent).
- Requires a repackage/swap (user-triggered) to reach the installed app.

## Status: scroll frame rate - streaming flushes held during glides, timer churn removed (2026-10-29 23:45)

The last measurable scroll frame-rate cost during a streaming turn: the throttled markdown flush (100ms cadence) collided with glide frames - each collision re-parses the growing tail block and (for code content) re-highlights it mid-scroll.

- smoothScroll.ts: module-level wheelGlideBusy() - true from the first wheel event through 250ms after the last glide frame (starts at -Infinity, so it is false before any real glide; caught by the throttling tests at process boot).
- useThrottledStreamingText: the cooldown flush now holds while wheelGlideBusy() (re-checks every 120ms) and publishes once the gesture settles; post-glide catch-up stays within one cooldown.
- scroll-area.tsx: active-scroll detection became a 100ms timestamp window instead of a per-scroll-event clearTimeout/setTimeout chain - the churn ran on every scroll frame in the hot path.

Checks: eslint clean x3, typecheck clean, scoped vitest 33/33 (adds useThrottledStreamingText 5). Requires a rebuild (user-triggered).

## Status: follow-live-edge semantics tightened (2026-10-29 23:46)

Request: while the user reads at the live edge, keep gluing the bottom as the response streams; after an up-scroll, never yank them down. The guards were all in place except two paths that made it feel broken:

- BaseChat handleRenderingComplete fired a 200-320ms scrollToBottom smooth tween per new message while following, lagging the live edge behind the per-flush instant pin for up to a third of a second. The tween is removed; only the initial session-load jump remains (the list pin + ScrollArea autoScroll cover the glue).
- The virtual list pin skipped glides but not native (trackpad) up-scrolls in the one-frame window before follow detaches, so the pin guard now also skips for 120ms after any real scroll movement (lastUserScrollAtRef).

Follow states after this: at-bottom + streaming = stuck to the live edge per flush; scrolled up mid-stream = nothing scrolls them (flush pin, RO pin, autoScroll, and the rendering-complete tween are all gated on isFollowing / userScrolledUp); a wheel-down back to the live edge re-attaches within a frame via the atLiveEdge rejoin.
 - Checks: eslint clean x2, typecheck clean, scoped vitest 19/19. Requires a rebuild (user-triggered).

## Status: command-block scroll frame drops (2026-10-29 23:51)

User-triggered repro: scrolling over command blocks drops frames. Two cost paths in tool/code cards: (a) heavy-card content-visibility conversions (addresses in the reveal passes below), and (b) Running command cards rebuild their live output <pre> per output line - liveOutputToString re-joins all accumulated chunks on every render and LiveOutputView then reads scrollHeight, a forced layout read, per notification.

- ToolCallWithResponse: the live output text now publishes through useThrottledStreamingText at the shared 100ms cadence (first line still appears instantly); the <pre> rebuild + scrollHeight read happen at most ~10x/s instead of per line.
- MessageList reveal passes are now cost-aware: each reveal absorbs its pending cv conversions inside the idle slot (one owned read) and halves/grows the chunk from the measured cost (REVEAL_BUDGET_MS 32) so converting a batch of heavy cards never stamps a scroll frame.
- Checks: eslint clean x2, typecheck clean, scoped vitest 55/55 (ToolCallWithResponse 7, MarkdownContent 29, MessageList 7, throttle hook 5, smoothScroll 7). Requires a rebuild (user-triggered).

## Streaming-lag refactor (chatSessionStore double deep-clone)

Date: 2026-10-30 ~00:05

Symptom: while the model streams, the UI lags and switching between chat sessions is slow.

Root cause: the store deep-cloned the entire message array twice per streamed chunk -
applyChatStateChanges cloned change.messages per chunk (the adapter emits the full
array from every update), then notify() -> snapshotFromEntry cloned entry.messages
again before handing it to React. Every chunk was O(session size) in allocations, and
it broke row memoization: every MessageRow saw a fresh object per flush, so React
walked every card deep per flush. Background sessions did the same clones while
another chat was open, which is what made session switching slow.

Fix: make the adapter's message state immutable.

- adapter/messages.ts: a streamed chunk clones only the touched message (metadata
  rebuilt with outputTokenLimitReached/fallbackContent/operationLogs/inference),
  rebuilds the content array by reference-copy, and replaces its slot via
  withMessageAt (index = length appends). findMessageForChunk returns
  {message, index} and adopts pending.messageId immutably;
  reconcileLocalSteerTextChunk now returns rebuilt content instead of assigning onto
  the shared message object.
- adapter/tools.ts, gooseSessionNotifications.ts, permissions.ts, elicitations.ts:
  every push/metadata write rebuilt the same way; message_usage locates its message
  by index instead of a reverse-copied .find.
- adapter/shared.ts: applyInferenceMeta -> metadataWithInferenceMeta(metadata, role,
  gooseMeta) returning new-or-same metadata; added withMessageAt; the messagesChange
  comment now documents the immutability contract.
- sessionNotificationAdapter: initialMessages adopted by reference; getMessages()
  shares the array (immutable after emission).
- chatSessionStore: the 'messages' case adopts change.messages by reference and
  snapshotFromEntry shares entry.messages; deep clones remain only for input coming
  from outside the store (setMessages, locally created steer rows).

Result: zero per-chunk cloning; a chunk pays O(touched message); untouched rows keep
object identity so MessageRow memo short-circuits instead of deep-walking cards;
background sessions notify without touching a whole transcript.

Validation: pnpm run typecheck clean; eslint on all 8 touched files (--max-warnings
0) clean; full vitest run 1066 passed / 8 failed with exactly the documented
pre-existing failures (chatSessionStore steer-accumulation x1 and
ProgressiveMessageList snap-back x1 both re-verified failing identically at HEAD via
git stash; CustomProviderForm credential timeouts x2; recipe/validation x4).
Requires rebuild to reach the installed app; user-triggered as usual.

## Multi-steer text reconciliation fix

Date: 2026-10-30 ~00:20

The long-failing chatSessionStore steer test (and the behavior it covers) is now fixed.
Not display perf work - a real adapter routing bug found while investigating the
pre-existing baseline failure.

Mechanism: findActiveMessageById only lets a chunk write into a message still at the
transcript tail (guard against reused provider completion ids). Queuing a second steer
moved the first steer row off the tail, so its echo chunks (user_message_chunk with
goose steer meta + server-assigned id) were rejected there; findMessageForChunk fell
through the id-less adoption and appended a duplicate row with the remaining text.
First steer froze at partial text on screen ("hel") with a phantom "lo" copy later.

Fix: findMessageForChunk routes steer chunks (isSteerChunk = gooseMeta.steer) by exact
id + role + metadata.steer at any position; reused-completion-id protection unchanged
for non-steer chunks (the steer fallback requires steer metadata, so the reused-id
regression test at sessionNotificationAdapter.test.ts "keeps a reused provider id as a
new reply after a later user turn" still holds). localSteerTextByMessageId seeding
(confirmedLocalSteerTextByMessageId) already carried the accumulated text across
adapter rebuilds, so the first chunk after a second steer re-joins mid-accumulation.

Validation: chatSessionStore.test.ts "preserves steer text accumulation when another
local steer is added" now passes (was failing deterministically at HEAD, re-verified
via git stash); new adapter test "routes steer chunks to their row after another steer
moves it off the tail"; scoped suites 66/66 green; full UI suite 1067 passed with only
the known pre-existing failures left (ProgressiveMessageList snap-back x1,
CustomProviderForm credential timeouts, recipe/validation x4). typecheck + eslint
clean.

## Session-load replay hold and direction-aware follow pins (bugs 1 + 2)

Date: 2026-10-30 ~00:45

Two user-visible bugs, both about who is allowed to move the viewport while a
session is mid-event.

Bug 1 - switching away while a session was still loading, then returning,
broke the loading animation and painted chat cards as they loaded. Root cause:
the replay hold was keyed to chatState === LoadingConversation, but a mid-replay
permission/elicitation card flips chatState to WaitingForUserInput, and from then
on per-chunk messages leaked into the store; separately, lists that mounted while
the replay held the transcript at zero messages never sized hydration, so when the
full conversation landed in one notify every card painted visibly (loading anim
gone while rows materialize). Fix: StoreEntry.loadInFlight (set by startSessionLoad,
cleared by finish/failSessionLoad) holds the transcript regardless of chatState:
getSnapshot serves entry.lastSnapshot, both notification fast paths hold, and the
applyChatStateChanges messages case ignores changes while in flight (covers the
direct callers that land permission cards). Plus VirtualMessageList re-runs
hydration sizing in a layout effect when message presence flips 0 -> N, so a
late-landing transcript sizes from the real length with rows hidden before paint.

Bug 2 - at the bottom while streaming (especially tool calls), the view drifted
up a little and stopped following. Two causes: (a) scroll-area stamped its last-
user-scroll time from scroll-position diffs, so programmatic scrolls generated by
the follow pin itself counted as user gestures and blocked the next pin while
content grew - the follower starved itself off the live edge; (b) the scroll-down-
button tween never cleared smoothingRef on completion (streaming growth moves the
live edge past the fixed tween target, so the tween finished above the bottom) and
a stuck smoothing flag blocked every follow pin until the next user gesture.

Fix: a module-level real-gesture clock in smoothScroll.ts (noteUserGesture,
userGestureRecent, endUserGesture) stamped ONLY by genuine departures from the
live edge. scroll-area handleScroll and VirtualMessageList read() stamp on
movedUp && !atLiveEdge classification; pointerdown/touchstart stamp (touch/pen
drag start); wheel events no longer stamp directly - a moving wheel fires scroll
events and the same classification applies, so a tick that stays inside the 48px
resume band cannot block gluing and a programmatic pin (which only moves down)
can never stamp, killing the self-starvation structurally. endUserGesture releases
the hold the moment a read sees the user back on the live edge (a rejoin is a
deliberate re-attach; the next flush glues immediately). smoothScrollTo gained an
onDone callback invoked on natural completion only (not on cancel): both
scroll-area scrollToBottom and MessageList scrollViewportTo clear their
smoothingRef through it.

Validation: new chatSessionStore test "holds replayed messages behind the
in-flight load even when chatState flips" (permission card mid-replay plus
chunks stay held; finishSessionLoad materializes all rows). The two previously
failing ProgressiveMessageList virtualization tests now pass with real semantics
- flushing the rAF-coalesced reads per scroll step also exposed that the old
position-diff stamping had been fed by pin scrolls, and that wheel ticks at the
bottom were blocking the growth pin. ProgressiveMessageList 14/14, full UI suite
1070 passed with only known pre-existing failures (recipe/validation zod 4.6.7
processor TypeError from goose-acp-client deps; CustomProviderForm credential
timeouts). typecheck + eslint (--max-warnings 0) on touched files clean. Requires
rebuild to reach the installed app; user-triggered as usual.

## Idle yank fix: conversion-driven growth pins and the in-band reading settle

Date: 2026-10-30 ~01:05

Symptom: whenever the user scrolled up, the app yanked them back down to the
bottom even with nothing streaming.

Root cause: scroll-area ResizeObserver auto-pin. While the user glided up a few
px (inside the 48px resume band, so no detach and - with direction-aware
stamping - no gesture stamp), the pre-warm/reveal content-visibility conversions
change row heights, the RO callback sees isFollowing true, and jump-scrolls to
the bottom. RO callbacks also run before the frame scroll handlers, so the yank
lands before classification could react; the old position-diff stamp had been
gating this by accident. Same hole in the autoScroll children-effect and in the
MessageList pin after a settled in-band nudge (followRef still true).

Fix layers:
1. Stamp the shared gesture clock on EVERY user-driven upward move (movedUp),
   not only moves that leave the band - during active up-scrolling the
   RO/autoScroll gates stay closed. Pins and other programmatic scrolls move
   down and still never stamp, so no self-starvation returns.
2. Reading settle (READING_SETTLE_MS 150): an in-band up-move no longer
   re-attaches follow on near-bottom reads. Re-attach now requires the exact
   bottom (distance <= 2 px). Both scrollers arm a settle timer that fires once
   the gesture goes quiet: parked above the exact bottom detaches follow
   (scroll-area flips isFollowing/userScrolledUpRef and reports onScrollChange;
   MessageList flips followRef), so conversions and stream growth stop moving
   the viewport while the user reads and the anchor correction keeps content
   steady instead.
3. Streaming glue preserved: while a turn is actively emitting, flushes
   re-glue within the band and beat the settle; a settle that finds distance
   <= 2 keeps follow on (keeps a new reply visible for a wheel tick that does
   not leave the bottom). Settle cancels on re-follow and scrollToBottom.

Validation: new scroll-area.test.tsx (in-band settle detach; beyond-band
immediate detach; settle landing at exact bottom keeps following) + MessageList
test (in-band nudge settles detached, growth does not yank, returning to the
exact bottom re-attaches with the next flush gluing). ProgressiveMessageList
14/14, full UI suite 1073 passed with only the known pre-existing failures
(recipe/validation zod dep, CustomProviderForm timeouts). typecheck + eslint
(--max-warnings 0) clean. Requires rebuild to reach the installed app;
user-triggered as usual.

## Status: scroll-frame layout reads removed (2026-10-30 12:10)

Code-path audit of the remaining per-frame work in a wheel glide. Three layout
reads were still happening on every glide frame, two of which forced pending
content-visibility layout synchronously.

- **ScrollArea scroll handler** read `scrollHeight` every coalesced frame via
  `isAtBottom()`. It now uses a cached `maxScrollTop` refreshed by the existing
  content `ResizeObserver`, the auto-scroll effect, and a mount layout effect.
  Falls back to a direct measurement when the maximum is 0 (content fits or the
  observer has not reported yet).
- **VirtualMessageList `read()`** did the same for its live-edge distance. Same
  cached maximum, refreshed by the list `ResizeObserver` and a per-session
  layout seed.
- **`attachWheelSmoothing`** read `scrollTop` twice per frame: once with `+=`
  and once after the write to detect clamping. The step now writes
  `currentTop + remaining * k` and remembers the predicted position; a mismatch
  on the next frame's start read goes through the existing rebase path, which
  also covers the scroll ceiling. One read per frame remains, for external
  movement detection only.

Checks: typecheck clean; eslint `--max-warnings 0` clean on the three files;
scoped vitest 40/40 (smoothScroll, scroll-area, MessageList,
ProgressiveMessageList). Requires a repackage/swap (user-triggered).

Feel tuning (user chose snappier + exact): `WHEEL_TAU_S` 0.2 -> 0.1; the glide
snaps the last <=4px to the wheel target once input goes idle, and the max
duration is measured from the last wheel event so a continuous gesture is not
cut at 600ms. New smoothScroll test asserts a notch lands exactly on target.
Scoped vitest 41/41.