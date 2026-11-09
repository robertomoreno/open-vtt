# Agent Instructions

## Project and scope

Gather is a local-first browser virtual tabletop. The current implementation covers creating/restoring games, shared rooms, approved player identities, shared dice rolls, and causal reconciliation of concurrent offline edits. Keep changes within this scope unless the user asks to expand it; the game-room UI is intentionally provisional and should remain replaceable.

Use `README.md` as the current user-facing reference. The approved scope and architecture are in `docs/superpowers/specs/2026-10-27-vtt-foundation-design.md`; implementation and acceptance history are in `docs/superpowers/plans/2026-10-27-vtt-foundation.md`. These are dated documents, so verify current behavior and status against the code, tests, and README before relying on old status notes. For WebRTC investigations, also read the relevant notes under `docs/superpowers/debugging/`.

## Stack and commands

- Use Node.js **22.12+** and npm. Keep `package-lock.json` in sync with dependency changes; do not introduce another package manager without asking.
- Install with `npm ci`; run the local app with `npm run dev` (localhost:5173).
- Run `npm run typecheck`, `npm test`, and `npm run build` for TypeScript, unit/DOM tests, and the production build.
- Run `npm run test:e2e` for Playwright browser tests. If browser binaries are missing, install the configured engines with `npx playwright install chromium firefox webkit`.
- No lint or formatter script is configured. Follow nearby TypeScript/CSS style and avoid unrelated reformatting.

## Architecture boundaries

- `src/game/`: durable game types, validation, and immutable game operations.
- `src/storage/`: browser saves, identity hints, and validated JSON import/export.
- `src/network/`: signaling codecs, bounded framing, and native WebRTC lifecycle; keep game rules, persistence, and DOM out.
- `src/session/`: host/guest authority, claims, request validation, presence, and snapshots; keep storage and DOM out.
- `src/ui/`: accessible views and application wiring. Keep views replaceable and connect them through small explicit callbacks/interfaces rather than adding a global event bus or state framework.
- `src/main.ts` should remain the application bootstrap. Put tests under the matching `tests/` area; use `tests/e2e/` for public browser flows.

Preserve the important ownership rules: the host is the sole writer of live game state; guests send typed requests, not authoritative state or results. A restored/imported snapshot starts an independent live session. Roles (`gm`/`pj`) and remembered browser identities are labels/convenience hints, not authentication; the one role-based game rule is that the participant seated as the GM is the only one allowed to add players.

## Shared-state reconciliation

These rules are now implemented by the causal peer session and reconciliation layer; preserve them when changing shared-state behavior.

Reconcile independent concurrent edits without warnings or data loss. Resolve conflicts only where concurrent operations compete for the same value or violate a game invariant; never choose an entire game snapshot as the winner.

Allow local edits before connecting. On connection, merge compatible changes. For genuinely conflicting fields or operations, retain the first room participant's version—even when that participant authored neither competing change—and preserve unrelated edits.

| Concurrent changes | Treatment |
|---|---|
| Two players edit their respective PJ sheets | Merge both |
| Two players edit independent fields on the same sheet | Merge both |
| Two players roll dice | Keep both rolls, each once |
| Two players set the same field to different values | Retain the first room participant's version of that field |
| Alice opens the room first with “Old Castle”; Bob and Carol concurrently rename it to different names | Keep Alice's “Old Castle,” even though she authored neither rename; preserve unrelated changes |
| A player edits their saved PJ sheet before connecting, while others edit independent data | Merge compatible local changes when the connection is established |
| Someone tries to add another player to the roster while offline | Do not add the player; creation requires an established connection and completed game synchronization |
| Separate edits combine into an invalid state—for example, two participants claim the same player | Resolve the violated game rule |

- “First participant” means whoever first opens the shared room, not whoever opened a local save earliest. This participant can edit like everyone else; they are not merely a referee.
- A connection may be initiated later by any participant. An offline edit is not a conflict merely because another participant's copy remains unchanged; preserve causality to distinguish competing edits from unchanged data.
- Additional players can only be added by the participant seated as the GM, after a connection is established and the game is synchronized, not offline. Enforce this in the session/operation path as well as the UI; a signaling socket alone is insufficient. Offline edits to existing players remain supported.
- An edit made after receiving an earlier edit is not a concurrent conflict; it updates the value normally.
- Model shared data as individual records and fields rather than one replaceable game or sheet JSON value. Yjs convergence alone does not enforce game invariants or first-entrant priority.
- First-entrant priority applies only to the incompatible field or indivisible operation, preserving unrelated changes. Show a warning detailing the competing changes, the outcome, and why it won.
- If the first entrant leaves, remaining participants keep playing and the next-earliest connected participant takes over conflict decisions. The successor's current validated version becomes the starting fallback for their priority tenure; a fresh room similarly starts from its opener's saved version rather than reviving an old participant's fallback.
- PJ sheets illustrate reconciliation semantics; these examples do not expand the current gameplay scope to include sheets.

## Behavior, privacy, and resilience

- Keep this a static client app: no account system, application backend, signaling service, gameplay relay, TURN service, analytics, or cloud saves unless the user explicitly changes scope. Current network discovery uses the documented public STUN configuration; STUN is not a data relay.
- Treat imported JSON, invite/reply payloads, and peer messages as untrusted. Validate structure, versions, references, and size bounds before applying data; invalid imports must not partially replace a save.
- Invitation/reply links contain network details and temporary credentials. Never persist SDP/ICE or connection credentials in game saves, logs, fixtures, or diagnostics. Redact links and signaling payloads from reports.
- Keep durable game data separate from transient peer/session state and browser-only identity hints. Preserve export and usable in-memory play when browser storage is unavailable.
- Feature-detect browser APIs rather than browser-sniffing. Explain unsupported APIs and secure-context requirements without crashing startup; keep keyboard access, labels, visible focus, and announced status/errors intact.
- Clean up peer connections, channels, listeners, timers, and temporary object URLs on cancellation, failure, leave, and teardown.

## Tests and compatibility claims

- Add or update focused tests for behavior changes and regressions. Use injected RTC/runtime/storage dependencies for deterministic unit tests where the existing modules provide them.
- Playwright end-to-end tests use the Page Object Model. Keep UI knowledge in `tests/e2e/pages/`, browser/test-data setup in `tests/e2e/support/`, and scenarios in the specs.
  - `tests/e2e/pages/gather-app.ts` (`GatherApp`) is the entry point. It composes the `start`, `table`, `playerChooser`, `restore`, and `share` screen objects and exposes shared flows such as `createGame`, `openSharedRoom`, `joinSharedRoom`, and `claimPlayer`.
  - Page objects own selectors, waits, and UI mechanics. Prefer accessible locators (`getByRole`, `getByLabel`) and expose semantic actions (`roll`, `addPlayer`, `downloadGame`) and named locators (`rolls`, `status`, `rosterEntry`) rather than raw DOM details.
  - Specs use the `app` fixture from `tests/e2e/support/fixtures.ts` for single-page scenarios and `Participant` from `tests/e2e/support/participant.ts` for multi-browser/multi-context scenarios. Do not duplicate selectors or waits in specs; page-wide assertions about malicious markup or browser capabilities may still use locators directly.
  - Add a new screen or flow to the matching page object first, then write the scenario. When labels or markup change, update the page object once instead of every spec. `provider-gate.page.ts` covers the standalone signaling fixture.
- End-to-end connection tests must exercise the real browser data channel and public UI flow. Do not replace them with mocked WebRTC, skip failing cases, or change privacy/network behavior just to obtain a green run.
- Direct WebRTC results depend on browser and network conditions. The README records unresolved interoperability results; inspect it and rerun the relevant tests before making compatibility claims. Report the exact engines/cases run and distinguish observed application failures from environmental limitations—do not infer that an unproven combination works. WebKit automation is not proof of shipping Safari behavior, and Chromium automation is not proof of branded Edge behavior.
- If browser tests cannot run, report that limitation and preserve the tests; do not describe the browser acceptance gate as passing based on unit tests, mocks, or a partial run.
