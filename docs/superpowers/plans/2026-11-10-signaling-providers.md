# Configurable Trystero Signaling Providers (Phase 1) Implementation Plan

> **Status:** Phase 1 was implemented on branch `feat/signaling-providers`. The
> task checkboxes below are the original plan, not a live completion tracker.
> Gate evidence is in
> `docs/superpowers/debugging/2026-11-10-nostr-provider-gate.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Trystero's signaling provider configurable, default production to Nostr with eight relays, keep development on the loopback WSS relay, and leave the room/session/UI contract unchanged.

**Architecture:** Add a validated `SignalingConfig` and a resolved `SignalingPlan`. `createRoomTransport` consumes the plan instead of hardcoded WSS URLs. Phase 1 ships two providers: the existing custom y-webrtc WSS strategy and `@trystero-p2p/nostr@0.26.0`. Provider modules are dynamically imported only when selected. MQTT, BitTorrent, Waku, and composite fan-out are deferred.

**Tech Stack:** TypeScript, Vite, Yjs, Trystero (`@trystero-p2p/core@0.26.0`, `@trystero-p2p/nostr@0.26.0`), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-10-signaling-providers-design.md`

## Global Constraints

- Node.js **22.12+**, npm; add only `@trystero-p2p/nostr@0.26.0` in Phase 1; keep `package-lock.json` in sync.
- `appId` is `gather-v2`; `maxReceiveBytes` is `12 * 1024 * 1024`; room-link secret remains Trystero's `password`.
- Production default: `nostr`, `redundancy: 8`. Development/Playwright default: `wss`, `ws://127.0.0.1:4444`.
- No public y-webrtc endpoint as a production default. A production WSS plan without URLs is an error, not a fallback.
- No provider or endpoint from a room link, import, invitation, or peer message.
- No SDP/ICE, room secret, relay credential, or endpoint in game saves, logs, errors, fixtures, or reports.
- No TURN, gameplay relay, server deployment, analytics, accounts, MQTT, BitTorrent, Waku, Firebase, Supabase, or multi-strategy fan-out in Phase 1.
- Preserve the bounded native RTC runtime, STUN-only ICE, the current 12 MiB receive budget (`AUDIO_TRANSFER_BYTES`), 32-participant / 31-connection / 8-pending-admission limits, handshake, actions, reconciliation, chat, and audio behavior.
- `src/session/` and `src/ui/` must not import provider-specific types.
- Do not overwrite or revert the existing uncommitted audio work in `src/session/audio.ts` and `tests/session/audio.test.ts`; this plan touches network/config/room/docs only.
- All participants in a room must use the same provider configuration; the room link does not carry a provider hint.
- Tests: `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e`; the new real Nostr gate is `npm run test:e2e:nostr`.

## Review Focus

These are the failure modes most likely to bite a real deployment; each has a test in the task that owns the code.

1. **Production silently stays on WSS** because an inherited `VITE_GATHER_SIGNALING_URLS` is present, or a missing provider falls back to the dead public endpoint. Expected: URL-only means WSS only when explicitly supplied; otherwise production is Nostr.
2. **Development or Playwright contacts public Nostr relays** and becomes flaky. Expected: development/test defaults to the loopback WSS relay unless the provider is explicitly overridden.
3. **Invalid configuration silently falls back** to a different provider or endpoint. Expected: a load-time error naming the invalid field, with no fallback.
4. **The loopback mDNS candidate rewrite is enabled for a remote or non-WSS provider.** Expected: `_test_only_mdnsHostFallbackToLoopback` only when the resolved plan is development WSS and every URL is loopback.
5. **The room secret or a signaling endpoint leaks** into a config view, error, or test fixture. Expected: only the opaque secret is passed to Trystero; views and errors contain neither the secret nor endpoints.

---

### Task 1: Signaling Types, Defaults, and Validation

**Files:**
- Create: `src/network/signaling/types.ts`
- Create: `src/network/signaling/config.ts`
- Modify: `src/network/config.ts`
- Modify: `src/network/limits.ts`
- Create: `tests/network/signaling-config.test.ts`
- Modify: `tests/network/config.test.ts`

**Interfaces:**
- Consumes: `check`, `object` from `src/game/validation.ts`; `SIGNALING_URL_LIMIT` from `src/network/limits.ts`.
- Produces:
  - In `src/network/limits.ts`: `NOSTR_RELAY_LIMIT = 8`, `NOSTR_DEFAULT_REDUNDANCY = 8`, `SIGNALING_REDUNDANCY_MIN = 1`.
  - In `src/network/config.ts`: `parseSignalingUrls(input: string, allowWs?: boolean, limit?: number): string[]`; `isLoopbackUrl(value: string): boolean`; `rtcConfiguration` remains.
  - In `src/network/signaling/types.ts`: `SignalingProviderId`, `SignalingConfig`, `SignalingPlan`.
  - In `src/network/signaling/config.ts`: `SIGNALING_APP_ID = 'gather-v2'`, `DEFAULT_DEV_SIGNALING_URL = 'ws://127.0.0.1:4444'`, `parseSignalingConfig(value: unknown, options: { dev: boolean }): SignalingConfig`, `loadSignalingConfig(options: LoadSignalingOptions): SignalingConfig`, `signalingConfig`, `readDevSignalingOverride(storage): unknown`.
  - Providers import the current receive budget as `AUDIO_TRANSFER_BYTES` from `src/network/limits.ts`; do not duplicate it.
  - `LoadSignalingOptions` is `{ dev: boolean; provider?: string; urls?: string; redundancy?: string; storage?: Pick<Storage, 'getItem'> | null }`.

- [ ] **Step 1: Write the failing signaling-config tests**

Create `tests/network/signaling-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadSignalingConfig, parseSignalingConfig } from '../../src/network/signaling/config';

const dev = { dev: true } as const;
const prod = { dev: false } as const;
const memory = (value: string | null) => ({ getItem: (_key: string) => value });

describe('signaling configuration', () => {
  it('defaults development to the loopback WSS relay', () => {
    expect(loadSignalingConfig(dev)).toEqual({
      provider: 'wss',
      urls: ['ws://127.0.0.1:4444'],
    });
  });

  it('defaults production to Nostr with redundancy 8', () => {
    expect(loadSignalingConfig(prod)).toEqual({ provider: 'nostr', redundancy: 8 });
  });

  it('treats a URL-only production override as WSS for compatibility', () => {
    expect(loadSignalingConfig({ ...prod, urls: 'wss://relay.example' })).toEqual({
      provider: 'wss',
      urls: ['wss://relay.example'],
    });
  });

  it('parses explicit Nostr URLs and redundancy', () => {
    expect(loadSignalingConfig({
      ...prod,
      provider: 'nostr',
      urls: 'wss://a.example,wss://b.example',
      redundancy: '3',
    })).toEqual({
      provider: 'nostr',
      urls: ['wss://a.example', 'wss://b.example'],
      redundancy: 3,
    });
  });

  it('rejects invalid providers, schemes, credentials, counts, and redundancy', () => {
    expect(() => parseSignalingConfig({ provider: 'mqtt' }, prod)).toThrow(/provider/i);
    expect(() => parseSignalingConfig({ provider: 'wss', urls: 'https://x.example' }, prod)).toThrow(/wss/i);
    expect(() => parseSignalingConfig({ provider: 'wss', urls: 'wss://u:p@x.example' }, prod)).toThrow(/credentials/i);
    expect(() => parseSignalingConfig({ provider: 'wss' }, prod)).toThrow(/URL/i);
    expect(() => parseSignalingConfig({ provider: 'nostr', redundancy: 0 }, prod)).toThrow(/redundancy/i);
    expect(() => parseSignalingConfig({ provider: 'nostr', redundancy: 9 }, prod)).toThrow(/redundancy/i);
    expect(() => parseSignalingConfig({ provider: 'wss', urls: Array(5).fill('wss://x.example') }, prod)).toThrow(/1–4/);
    expect(() => parseSignalingConfig({ provider: 'nostr', urls: Array(9).fill('wss://x.example') }, prod)).toThrow(/1–8/);
    expect(() => parseSignalingConfig({ provider: 'nostr', extra: true }, prod)).toThrow(/Unexpected fields/i);
  });

  it('reads development JSON and legacy CSV overrides, but production ignores storage', () => {
    const json = JSON.stringify({ provider: 'nostr', redundancy: 4 });
    expect(loadSignalingConfig({ ...dev, storage: memory(json) })).toEqual({
      provider: 'nostr',
      redundancy: 4,
    });
    expect(loadSignalingConfig({ ...dev, storage: memory('ws://127.0.0.1:5555') })).toEqual({
      provider: 'wss',
      urls: ['ws://127.0.0.1:5555'],
    });
    expect(loadSignalingConfig({ ...prod, storage: memory(json) })).toEqual({
      provider: 'nostr',
      redundancy: 8,
    });
  });

  it('rejects fragments and query strings in signaling URLs', () => {
    expect(() => parseSignalingConfig({ provider: 'wss', urls: 'wss://x.example/#frag' }, prod)).toThrow(/URL/i);
    expect(() => parseSignalingConfig({ provider: 'wss', urls: 'wss://x.example/?a=1' }, prod)).toThrow(/URL/i);
  });
});
```

Update `tests/network/config.test.ts` so it no longer imports `roomNetworkConfig` or tests signaling environment defaults. Keep and extend the URL parser tests:

```ts
import { describe, expect, it } from 'vitest';
import { isLoopbackUrl, parseSignalingUrls, rtcConfiguration } from '../../src/network/config';

describe('network configuration', () => {
  it('uses explicit STUN-only ICE', () => {
    const urls = rtcConfiguration.iceServers?.flatMap(server => server.urls) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url.startsWith('stun:')).toBe(true);
  });

  it('accepts up to the provider limit of secure signaling URLs', () => {
    expect(parseSignalingUrls('wss://a.example, wss://b.example')).toEqual([
      'wss://a.example',
      'wss://b.example',
    ]);
  });

  it('rejects non-wss, empty, oversized, and credential-bearing lists', () => {
    expect(() => parseSignalingUrls('ws://a.example')).toThrow();
    expect(() => parseSignalingUrls('https://a.example')).toThrow();
    expect(() => parseSignalingUrls('')).toThrow();
    expect(() => parseSignalingUrls('wss://a.example,wss://b.example,wss://c.example,wss://d.example,wss://e.example')).toThrow();
    expect(() => parseSignalingUrls('wss://user:pass@a.example')).toThrow(/credentials/i);
    expect(() => parseSignalingUrls('wss://a.example/#fragment')).toThrow(/URL/i);
  });

  it('recognizes loopback hosts', () => {
    expect(isLoopbackUrl('ws://127.0.0.1:4444')).toBe(true);
    expect(isLoopbackUrl('ws://localhost:4444')).toBe(true);
    expect(isLoopbackUrl('ws://[::1]:4444')).toBe(true);
    expect(isLoopbackUrl('wss://relay.example')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npx vitest run tests/network/signaling-config.test.ts tests/network/config.test.ts
```

Expected: FAIL because the signaling modules and new helpers do not exist.

- [ ] **Step 3: Implement the types, constants, and parser**

In `src/network/limits.ts`, keep `SIGNALING_URL_LIMIT = 4` and add:

```ts
export const NOSTR_RELAY_LIMIT = 8;
export const NOSTR_DEFAULT_REDUNDANCY = 8;
export const SIGNALING_REDUNDANCY_MIN = 1;
```

In `src/network/signaling/types.ts` define the types exactly as in the spec:

```ts
import type { JoinRoom, JoinRoomConfig } from '@trystero-p2p/core';

export type SignalingProviderId = 'wss' | 'nostr';

export type SignalingConfig =
  | { provider: 'wss'; urls: string[] }
  | { provider: 'nostr'; urls?: string[]; redundancy: number };

export type SignalingPlan = {
  id: SignalingProviderId;
  join: JoinRoom<JoinRoomConfig>;
  base: { appId: string; maxReceiveBytes: number; trickleIce?: boolean };
  relayConfig?: JoinRoomConfig['relayConfig'];
  allowsLoopbackCandidateFallback: boolean;
};
```

In `src/network/config.ts`:

- Keep the existing `roomNetworkConfig`, `signalingIsLoopback`, `publicSignalingUrl`, `localSignalingUrl`, and `devSignalingOverride` temporarily so Task 1 leaves the repository type-checking. Task 2 removes them when `room.ts` switches to the plan.
- Change `parseSignalingUrls(input, allowWs = false, limit = SIGNALING_URL_LIMIT)` and make the count error use the supplied limit, e.g. `Configure 1–${limit} signaling URLs.`
- Reject `parsed.username` or `parsed.password` with `Signaling URLs must not contain credentials.`
- Reject `parsed.search` or `parsed.hash` with `Signaling URLs must be valid wss:// URLs.`
- Export `isLoopbackUrl` with the current loopback-host logic.

In `src/network/signaling/config.ts`:

- Use `check` and `object` from `../../game/validation`.
- Normalize a URL value (`string` comma-separated or `string[]`) through `parseSignalingUrls` with `allowWs = options.dev` and the provider limit (`4` for WSS, `8` for Nostr).
- `provider` defaults to `wss` when URLs are present or development is true; otherwise `nostr`. Treat empty or whitespace-only environment values as absent.
- Development WSS with no URLs defaults to `['ws://127.0.0.1:4444']`; production WSS with no URLs throws `Configure 1–4 signaling URLs.`
- Nostr with no URLs defaults to `NOSTR_DEFAULT_REDUNDANCY`; validate an explicit redundancy as an integer in `1..NOSTR_RELAY_LIMIT`.
- Reject fields outside `['provider','urls','redundancy']`. Reject `redundancy` when the provider is `wss`. Treat an empty URLs string/array for Nostr as no explicit list.
- `readDevSignalingOverride` returns a JSON object/string from `storage.getItem('gather:dev:signaling')`, or the raw legacy CSV string; return `undefined` on storage errors or no value.
- `loadSignalingConfig` gives the dev override precedence over environment values, then environment, then defaults. It must not read storage when `dev` is false.
- `parseSignalingConfig` is the pure validator used by both paths.
- Export `signalingConfig` built from `import.meta.env.DEV`, `VITE_GATHER_SIGNALING_PROVIDER`, `VITE_GATHER_SIGNALING_URLS`, `VITE_GATHER_SIGNALING_REDUNDANCY`, and (only in development) a `localStorage` reference obtained inside `try/catch` (`typeof window === 'undefined' ? null : window.localStorage`) so Node-based tests and denied storage do not throw.

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npx vitest run tests/network/signaling-config.test.ts tests/network/config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/network/signaling/types.ts src/network/signaling/config.ts src/network/config.ts src/network/limits.ts tests/network/signaling-config.test.ts tests/network/config.test.ts
git commit -m "feat: add validated signaling provider configuration"
```

---

### Task 2: WSS Plan and Room Integration

**Files:**
- Create: `src/network/signaling/providers/wss.ts`
- Create: `src/network/signaling/resolve.ts`
- Modify: `src/network/room.ts`
- Modify: `src/network/config.ts`
- Create: `tests/network/signaling-plan.test.ts`
- Modify: `tests/network/room.test.ts`
- Modify: `tests/network/room-core.test.ts`

**Interfaces:**
- Consumes: `SignalingConfig`, `SignalingPlan` from Task 1; `createGatherSignalingStrategy` from `src/network/trystero-signaling.ts`; `isLoopbackUrl` from `src/network/config.ts`.
- Produces:
  - `createWssPlan(config: Extract<SignalingConfig, { provider: 'wss' }>, options: { dev: boolean }): Promise<SignalingPlan>`
  - `resolveSignalingPlan(config: SignalingConfig, options?: { dev?: boolean }): Promise<SignalingPlan>` — Task 2 resolves only `wss`; `nostr` rejects with `Nostr signaling is not implemented yet.`
  - `RoomTransportOptions` gains `plan?: SignalingPlan`.
  - `createRoomTransport` uses `options.plan ?? await resolveSignalingPlan(signalingConfig)` and passes the plan's base/relay config to the room.

- [ ] **Step 1: Write the failing WSS-plan and room tests**

Create `tests/network/signaling-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveSignalingPlan } from '../../src/network/signaling/resolve';

describe('signaling plans', () => {
  it('builds a loopback WSS plan with the exact shared config', async () => {
    const plan = await resolveSignalingPlan(
      { provider: 'wss', urls: ['ws://127.0.0.1:4444'] },
      { dev: true },
    );
    expect(plan.id).toBe('wss');
    expect(plan.base).toEqual({ appId: 'gather-v2', maxReceiveBytes: 12 * 1024 * 1024 });
    expect(plan.relayConfig).toEqual({ urls: ['ws://127.0.0.1:4444'] });
    expect(plan.allowsLoopbackCandidateFallback).toBe(true);
    expect(typeof plan.join).toBe('function');
  });

  it('does not allow the loopback candidate rewrite for a remote URL', async () => {
    const plan = await resolveSignalingPlan(
      { provider: 'wss', urls: ['wss://relay.example'] },
      { dev: true },
    );
    expect(plan.allowsLoopbackCandidateFallback).toBe(false);
  });
});
```

In `tests/network/room.test.ts`:

- Replace the `roomNetworkConfig` import with:

```ts
import { rtcConfiguration } from '../../src/network/config';
import type { SignalingPlan } from '../../src/network/signaling/types';
```

- Add a plan helper:

```ts
const plan = (join: NonNullable<RoomTransportOptions['join']>, overrides: Partial<SignalingPlan> = {}): SignalingPlan => ({
  id: 'wss',
  join,
  base: { appId: 'gather-v2', maxReceiveBytes: 12 * 1024 * 1024 },
  relayConfig: { urls: ['wss://signal.example'] },
  allowsLoopbackCandidateFallback: false,
  ...overrides,
});
```

- Pass `{ plan: plan(fake.join), native: ... }` in `start` and in the direct `createRoomTransport` calls.
- Update the exact-config test:

```ts
expect(config.appId).toBe('gather-v2');
expect(config.maxReceiveBytes).toBe(12 * 1024 * 1024);
expect(config.relayConfig).toEqual({ urls: ['wss://signal.example'] });
expect(config.rtcConfig).toBe(rtcConfiguration);
expect(config.rtcConfig.iceServers?.flatMap(server => server.urls).every((url: string) => url.startsWith('stun:'))).toBe(true);
expect(config.password).toHaveLength(43);
expect(config._test_only_mdnsHostFallbackToLoopback).toBeUndefined();
expect(JSON.stringify(t.getView())).not.toContain(config.password);
```

- Add:

```ts
it('enables the loopback candidate rewrite only when the plan allows it', async () => {
  const fake = fakeJoin();
  const t = createRoomTransport(new Y.Doc(), link(), 'me', {
    plan: plan(fake.join, { allowsLoopbackCandidateFallback: true }),
    native: { RTCPeerConnection: FakePc as any },
  });
  await vi.waitFor(() => expect(fake.state.room).toBeDefined());
  expect(fake.state.configs[0]._test_only_mdnsHostFallbackToLoopback).toBe(true);
  t.close();
});
```

In `tests/network/room-core.test.ts`, pass a plan to the injected joiner so the test does not resolve the default provider:

```ts
const join = await loadCoreJoiner(bus);
const t = createRoomTransport(doc, link, name, {
  join,
  plan: {
    id: 'wss',
    join,
    base: { appId: 'gather-v2', maxReceiveBytes: 12 * 1024 * 1024 },
    relayConfig: { urls: ['ws://127.0.0.1:4444'] },
    allowsLoopbackCandidateFallback: true,
  },
  native: { RTCPeerConnection: createFakeRtc(net, name) as any },
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npx vitest run tests/network/signaling-plan.test.ts tests/network/room.test.ts tests/network/room-core.test.ts
```

Expected: FAIL because the plan modules and `plan` option do not exist.

- [ ] **Step 3: Implement the WSS plan, resolver, and room integration**

`src/network/signaling/providers/wss.ts`:

```ts
import { isLoopbackUrl } from '../../config';
import { AUDIO_TRANSFER_BYTES } from '../../limits';
import { SIGNALING_APP_ID } from '../config';
import type { SignalingConfig, SignalingPlan } from '../types';

export async function createWssPlan(
  config: Extract<SignalingConfig, { provider: 'wss' }>,
  options: { dev: boolean },
): Promise<SignalingPlan> {
  const { createGatherSignalingStrategy } = await import('../../trystero-signaling');
  return {
    id: 'wss',
    join: createGatherSignalingStrategy(),
    base: { appId: SIGNALING_APP_ID, maxReceiveBytes: AUDIO_TRANSFER_BYTES },
    relayConfig: { urls: config.urls },
    allowsLoopbackCandidateFallback:
      options.dev && config.urls.every(isLoopbackUrl),
  };
}
```

`src/network/signaling/resolve.ts`:

```ts
import { createWssPlan } from './providers/wss';
import type { SignalingConfig, SignalingPlan } from './types';

export async function resolveSignalingPlan(
  config: SignalingConfig,
  options: { dev?: boolean } = {},
): Promise<SignalingPlan> {
  const dev = options.dev ?? import.meta.env.DEV;
  if (config.provider === 'wss') return createWssPlan(config, { dev });
  throw new Error('Nostr signaling is not implemented yet.');
}
```

`src/network/room.ts`:

- Import `rtcConfiguration` from `./config`.
- Import `signalingConfig` from `./signaling/config`.
- Import `resolveSignalingPlan` from `./signaling/resolve`.
- Import `type SignalingPlan` from `./signaling/types`.
- Add `plan?: SignalingPlan` to `RoomTransportOptions`.
- In `start`, resolve the plan inside the existing `try`:

```ts
const plan = options.plan ?? await resolveSignalingPlan(signalingConfig);
if (closed) return;
const join = options.join ?? plan.join;
runtime = createBoundedRtcRuntime(...);
room = join({
  ...plan.base,
  password: link.secret,
  relayConfig: plan.relayConfig,
  rtcConfig: rtcConfiguration,
  rtcPolyfill: runtime.rtcPolyfill,
  ...(plan.allowsLoopbackCandidateFallback ? { _test_only_mdnsHostFallbackToLoopback: true } : {}),
}, link.roomId, {
  onPeerHandshake: handshake,
  onJoinError: details => { /* existing redacted handling */ },
});
```

Keep the existing `unsupported` feature check and error handling. Remove `roomNetworkConfig` and `signalingIsLoopback` imports.

After `room.ts` uses the plan, remove the now-unused `publicSignalingUrl`, `localSignalingUrl`, `devSignalingOverride`, `signalingUrls`, `signalingIsLoopback`, and `roomNetworkConfig` from `src/network/config.ts`. Keep `rtcConfiguration`, `parseSignalingUrls`, and `isLoopbackUrl`.

**Intermediate state:** Task 2 resolves only WSS. Do not deploy between Tasks 2 and 3; Task 3 completes the production Nostr provider and default. The unit suite in Task 2 uses injected plans and does not require the Nostr provider.

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npx vitest run tests/network/signaling-plan.test.ts tests/network/room.test.ts tests/network/room-core.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/network/signaling/providers/wss.ts src/network/signaling/resolve.ts src/network/room.ts src/network/config.ts tests/network/signaling-plan.test.ts tests/network/room.test.ts tests/network/room-core.test.ts
git commit -m "refactor: resolve room signaling through a provider plan"
```

---

### Task 3: Nostr Provider and Production Default

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `src/network/signaling/providers/nostr.ts`
- Modify: `src/network/signaling/resolve.ts`
- Create: `tests/network/signaling-nostr.test.ts`
- Modify: `tests/network/room.test.ts`
- Modify: `tests/network/signaling-config.test.ts`

**Interfaces:**
- Consumes: `SignalingConfig`, `SignalingPlan`; `SIGNALING_APP_ID`; `AUDIO_TRANSFER_BYTES`; `@trystero-p2p/nostr`'s `joinRoom`.
- Produces:
  - `createNostrPlan(config: Extract<SignalingConfig, { provider: 'nostr' }>, options: { dev: boolean }): Promise<SignalingPlan>`
  - `resolveSignalingPlan` now resolves both `wss` and `nostr`.
  - `relayConfig` for Nostr is `{ urls?, redundancy, warnOnRelayFailure }`; `urls` is omitted when no explicit list is supplied.

- [ ] **Step 1: Write the failing Nostr tests**

Create `tests/network/signaling-nostr.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { joinRoom } = vi.hoisted(() => ({ joinRoom: vi.fn() }));
vi.mock('@trystero-p2p/nostr', () => ({ joinRoom }));

import { resolveSignalingPlan } from '../../src/network/signaling/resolve';

describe('Nostr signaling plan', () => {
  beforeEach(() => joinRoom.mockReset());

  it('builds the production default with redundancy 8', async () => {
    const plan = await resolveSignalingPlan(
      { provider: 'nostr', redundancy: 8 },
      { dev: false },
    );
    expect(plan.id).toBe('nostr');
    expect(plan.join).toBe(joinRoom);
    expect(plan.base).toEqual({ appId: 'gather-v2', maxReceiveBytes: 12 * 1024 * 1024 });
    expect(plan.relayConfig).toEqual({ redundancy: 8, warnOnRelayFailure: false });
    expect(plan.allowsLoopbackCandidateFallback).toBe(false);
  });

  it('uses explicit relays and warns in development', async () => {
    const plan = await resolveSignalingPlan(
      { provider: 'nostr', urls: ['wss://a.example'], redundancy: 8 },
      { dev: true },
    );
    expect(plan.relayConfig).toEqual({
      urls: ['wss://a.example'],
      redundancy: 8,
      warnOnRelayFailure: true,
    });
    expect(plan.allowsLoopbackCandidateFallback).toBe(false);
  });
});
```

Add to `tests/network/room.test.ts`:

```ts
it('passes Nostr relay config and no loopback rewrite to the room', async () => {
  const fake = fakeJoin();
  const t = createRoomTransport(new Y.Doc(), link(), 'me', {
    plan: plan(fake.join, {
      id: 'nostr',
      relayConfig: { redundancy: 8, warnOnRelayFailure: false },
      allowsLoopbackCandidateFallback: false,
    }),
    native: { RTCPeerConnection: FakePc as any },
  });
  await vi.waitFor(() => expect(fake.state.room).toBeDefined());
  expect(fake.state.configs[0].relayConfig).toEqual({ redundancy: 8, warnOnRelayFailure: false });
  expect(fake.state.configs[0]._test_only_mdnsHostFallbackToLoopback).toBeUndefined();
  t.close();
});
```

Add to `tests/network/signaling-config.test.ts`:

```ts
it('switches production to Nostr when the provider is explicitly selected', () => {
  expect(loadSignalingConfig({ ...prod, provider: 'nostr' })).toEqual({
    provider: 'nostr',
    redundancy: 8,
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npx vitest run tests/network/signaling-nostr.test.ts tests/network/room.test.ts tests/network/signaling-config.test.ts
```

Expected: FAIL because `@trystero-p2p/nostr` and the Nostr plan do not exist.

- [ ] **Step 3: Install the exact dependency and implement the Nostr plan**

Run:

```bash
npm install @trystero-p2p/nostr@0.26.0 --save-exact
```

`src/network/signaling/providers/nostr.ts`:

```ts
import { AUDIO_TRANSFER_BYTES } from '../../limits';
import { SIGNALING_APP_ID } from '../config';
import type { SignalingConfig, SignalingPlan } from '../types';

export async function createNostrPlan(
  config: Extract<SignalingConfig, { provider: 'nostr' }>,
  options: { dev: boolean },
): Promise<SignalingPlan> {
  const { joinRoom } = await import('@trystero-p2p/nostr');
  return {
    id: 'nostr',
    join: joinRoom,
    base: { appId: SIGNALING_APP_ID, maxReceiveBytes: AUDIO_TRANSFER_BYTES },
    relayConfig: {
      ...(config.urls === undefined ? {} : { urls: config.urls }),
      redundancy: config.redundancy,
      warnOnRelayFailure: options.dev,
    },
    allowsLoopbackCandidateFallback: false,
  };
}
```

Update `src/network/signaling/resolve.ts`:

```ts
import { createNostrPlan } from './providers/nostr';
import { createWssPlan } from './providers/wss';

export async function resolveSignalingPlan(config, options = {}) {
  const dev = options.dev ?? import.meta.env.DEV;
  return config.provider === 'wss'
    ? createWssPlan(config, { dev })
    : createNostrPlan(config, { dev });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npx vitest run tests/network/signaling-nostr.test.ts tests/network/room.test.ts tests/network/signaling-config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Verify the production build code-splits the provider**

Run:

```bash
npm run build
```

Expected: PASS. The build may emit a separate dynamic-import chunk for `@trystero-p2p/nostr`; do not add it to the initial entry bundle.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/network/signaling/providers/nostr.ts src/network/signaling/resolve.ts tests/network/signaling-nostr.test.ts tests/network/room.test.ts tests/network/signaling-config.test.ts
git commit -m "feat: default production signaling to Nostr"
```

---

### Task 4: Documentation and Configuration Guidance

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/research/2026-11-10-trystero-signaling-options.md` only if a link/status needs updating
- Test: documentation review; no runtime test

**Interfaces:**
- Consumes: the final provider names, defaults, and environment variables from Tasks 1–3.
- Produces: operator-facing instructions that match the code exactly.

- [ ] **Step 1: Replace the production signaling description**

In `README.md`, update the network-privacy section from the public y-webrtc
default to:

- Production defaults to public Nostr relays with eight-relay redundancy;
  development and Playwright use the loopback WSS relay.
- Nostr relays see IP addresses, a random per-page pubkey, ephemeral event
  kinds, a hashed room topic, timing, and payload lengths; SDP/ICE is encrypted
  with the room secret; announcements contain a peer ID.
- Public relays have no SLA and can rate-limit, block ephemeral kinds, or
  disappear.
- All participants must use the same provider configuration; the room link does
  not carry a provider.
- No TURN; public signaling does not make restrictive networks connect.

- [ ] **Step 2: Add the configuration table**

Add a short section after the local-relay instructions:

```text
VITE_GATHER_SIGNALING_PROVIDER=wss|nostr
VITE_GATHER_SIGNALING_URLS=wss://relay-a.example,wss://relay-b.example
VITE_GATHER_SIGNALING_REDUNDANCY=8
```

Document:

- Production default is `nostr`; development default is `wss` loopback.
- `VITE_GATHER_SIGNALING_URLS` without a provider implies `wss` for backward
  compatibility.
- A production WSS configuration requires explicit URLs; there is no public
  y-webrtc fallback.
- `VITE_GATHER_SIGNALING_REDUNDANCY` applies to Nostr when no URL list is
  supplied; valid range 1–8.
- `localStorage['gather:dev:signaling']` accepts JSON or the legacy CSV WSS
  list and is ignored in production.
- Example Nostr-only deployment:

```bash
VITE_GATHER_SIGNALING_PROVIDER=nostr \
VITE_GATHER_SIGNALING_REDUNDANCY=8 \
npm run build
```

- Example self-hosted WSS deployment:

```bash
VITE_GATHER_SIGNALING_PROVIDER=wss \
VITE_GATHER_SIGNALING_URLS=wss://relay.example \
npm run build
```

- [ ] **Step 3: Remove stale production-WSS claims**

Run:

```bash
grep -R "y-webrtc-eu.fly.dev\|roomNetworkConfig.signaling" README.md src tests
```

Expected: no matches. Historical debugging notes under `docs/` may still
contain the old endpoint; leave those dated records intact.

- [ ] **Step 4: Review the docs against the code**

Check every default, environment variable, and range against
`src/network/signaling/config.ts`. Do not document MQTT, BitTorrent, Waku, or
composite mode as available in Phase 1.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/research/2026-11-10-trystero-signaling-options.md
git commit -m "docs: describe configurable signaling providers"
```

---

### Task 5: Real-Browser Nostr Gate and Full Regression

**Files:**
- Create: `playwright.nostr.config.ts`
- Create: `tests/e2e/nostr-gate.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `package.json` (add `test:e2e:nostr`)
- Create: `docs/superpowers/debugging/2026-11-10-nostr-provider-gate.md` with the run record or blocker

**Interfaces:**
- Consumes: the default production Nostr plan from Task 3; the existing
  `ProviderGatePage` and provider-gate fixture.
- Produces: an opt-in real-browser gate that uses public Nostr relays with no
  local signaling server, plus a recorded result.

- [ ] **Step 1: Add the Nostr Playwright config**

Create `playwright.nostr.config.ts`:

```ts
import { defineConfig } from '@playwright/test';
import { APP_URL } from './tests/e2e/config';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/nostr-gate.spec.ts',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  use: { baseURL: APP_URL, trace: 'retain-on-failure', actionTimeout: 15_000 },
  webServer: [
    {
      command: 'VITE_GATHER_SIGNALING_URLS= VITE_GATHER_SIGNALING_PROVIDER=nostr VITE_GATHER_SIGNALING_REDUNDANCY=8 npm run dev:e2e',
      url: APP_URL,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
```

Add to `package.json` scripts:

```json
"test:e2e:nostr": "playwright test -c playwright.nostr.config.ts"
```

- [ ] **Step 2: Add the real Nostr browser gate**

Create `tests/e2e/nostr-gate.spec.ts`:

```ts
import { test, expect, chromium, webkit, type WebSocketRoute } from '@playwright/test';
import { createRoomLink, roomLink } from '../../src/network/room-link';
import { APP_URL } from './config';
import { ProviderGatePage } from './pages/provider-gate.page';

for (const [a, b] of [['chromium', 'webkit'], ['webkit', 'chromium']]) {
  test(`${a} ↔ ${b}: public Nostr discovery opens native channels and carries binary values`, async () => {
    test.setTimeout(180_000);
    const browserA = await (a === 'chromium' ? chromium : webkit).launch();
    const browserB = await (b === 'chromium' ? chromium : webkit).launch();
    try {
      const contextA = await browserA.newContext({ baseURL: APP_URL });
      const contextB = await browserB.newContext({ baseURL: APP_URL });
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();
      const socketsA: WebSocketRoute[] = [];
      const socketsB: WebSocketRoute[] = [];

      await pageA.routeWebSocket(/^wss:\/\//, ws => { socketsA.push(ws); ws.connectToServer(); });
      await pageB.routeWebSocket(/^wss:\/\//, ws => { socketsB.push(ws); ws.connectToServer(); });

      const link = roomLink(createRoomLink('nostr-gate-game'), `${APP_URL}/`);
      const gateA = new ProviderGatePage(pageA);
      const gateB = new ProviderGatePage(pageB);

      await gateA.open(link, 'alice');
      await gateB.open(link, 'bob');

      await expect(gateA.opens).not.toHaveText('0', { timeout: 90_000 });
      await expect(gateB.opens).not.toHaveText('0', { timeout: 90_000 });
      await expect(gateA.phase).toHaveText('connected');
      await expect(gateB.phase).toHaveText('connected');
      expect(socketsA.length + socketsB.length).toBeGreaterThan(0);

      await gateA.publish('nostr-hello-from-a');
      await expect(gateB.received).toContainText('small-alice=nostr-hello-from-a');
      await gateA.publishLarge(7);
      await gateB.expectLargeValue('large-alice', 7);

      for (const ws of [...socketsA, ...socketsB]) await ws.close();

      await gateB.publish('nostr-after-closed-from-b');
      await expect(gateA.received).toContainText('small-bob=nostr-after-closed-from-b');
      await gateA.publishLarge(11);
      await gateB.expectLargeValue('large-alice', 11);

      await gateA.closeConnection();
      await gateB.closeConnection();
      await contextA.close();
      await contextB.close();
    } finally {
      await browserA.close();
      await browserB.close();
    }
  });
}
```

In `playwright.config.ts`, add `'**/nostr-gate.spec.ts'` to every `testIgnore` list so the
default local-relay suite never runs the public Nostr gate:

```ts
testIgnore: ['**/connections.spec.ts', '**/provider-gate.spec.ts', '**/chat.spec.ts', '**/nostr-gate.spec.ts']
```

- [ ] **Step 3: Run the real Nostr gate**

Run:

```bash
npm run test:e2e:nostr
```

Expected: PASS for both directions. Record:

- exact engines and versions;
- date/time and network;
- whether public relays were reachable;
- any relay rejection/rate-limit messages;
- whether large binary values were byte-for-byte correct.

If the gate fails because public Nostr relays are unreachable or reject the
event kind, create `docs/superpowers/debugging/2026-11-10-nostr-provider-gate.md`
with the observed failure and leave the production default behind a clearly
reported blocker. Do not claim the Nostr default is accepted from unit tests or
the loopback gate.

- [ ] **Step 4: Run the full regression**

Run:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Expected:

- typecheck passes;
- unit/DOM tests pass;
- production build passes;
- the local-relay Playwright suite passes in the already-established matrix.

Report exact engines and any environmental limitations. Do not replace a failing
real-browser case with a mock or skip it.

- [ ] **Step 5: Commit**

```bash
git add playwright.nostr.config.ts playwright.config.ts tests/e2e/nostr-gate.spec.ts package.json package-lock.json docs/superpowers/debugging/2026-11-10-nostr-provider-gate.md
git commit -m "test: add public Nostr browser gate"
```

---

## Self-Review

### Spec coverage

- Provider abstraction and `SignalingPlan` — Tasks 1–3.
- Production Nostr default with redundancy 8 — Tasks 1 and 3.
- Development loopback WSS default — Tasks 1–2.
- Config validation and dev/production storage split — Task 1.
- Room integration and loopback candidate fallback — Task 2.
- Provider-specific config and dynamic import — Tasks 2–3.
- README/privacy/operator guidance — Task 4.
- Real-browser Nostr gate and regression — Task 5.
- Deferred MQTT/BitTorrent/Waku/composite — explicitly excluded by Global Constraints and spec non-goals.

### Type consistency

- `SignalingProviderId` uses `wss` and `nostr` only in Phase 1.
- `SignalingPlan.base` is the same shape in tests, WSS plan, and Nostr plan.
- `relayConfig` is `JoinRoomConfig['relayConfig']` throughout.
- `allowsLoopbackCandidateFallback` is the single loopback flag used by `room.ts`.
- `resolveSignalingPlan(config, { dev? })` is the same signature in every task.

### Review Focus tests

1. Production silently stays on WSS — Task 1 URL-only and default tests; Task 3 explicit provider test.
2. Development contacts public Nostr — Task 1 development default; Task 2 loopback plan test.
3. Invalid config silently falls back — Task 1 validation tests.
4. Loopback rewrite enabled for remote/non-WSS — Task 2 loopback flag tests and Task 3 no-loopback test.
5. Secret or endpoint leak — Task 2 exact-config/password/view assertions.

### Proportion

The plan is longer than a minimal patch because the configuration has several
failure modes and the tests pin exact values. Implementation bodies are limited
to signatures and short mappings; test code is included where the exact values
matter. The deferred providers are not implemented or stubbed with fake
behavior.
