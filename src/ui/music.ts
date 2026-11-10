import { AUDIO_BYTES } from '../network/limits';
import type { AudioActions, AudioPanelView, AudioTrackView } from './audio';
import { el } from './dom';

export type MusicView = { update(view: AudioPanelView): void; destroy(): void };

const MIB = 1024 * 1024;
const FORMER_PLAYER = 'Former player';
const EMPTY_LIBRARY = 'No music in this room yet.';
const GAIN_MAX = 200;
const LOCAL_MAX = 100;
const SEEK_STEP_MS = 100;
const RECENT_INTERACTION_MS = 400;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}

function megabytes(bytes: number): string {
  const value = bytes / MIB;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} MB`;
}

function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < MIB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MIB).toFixed(1)} MB`;
}

/** Whole seconds only: a music panel does not need sub-second precision. */
function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function availability(track: AudioTrackView): string {
  if (track.downloading) return `Downloading ${clamp(track.progress * 100, 0, 100)}%`;
  if (!track.available) return 'Not available in this room';
  return 'Ready';
}

/**
 * Interaction state per range input. Focus is deliberately not part of it: a focused but
 * idle slider must accept a shared update. Only an active pointer drag, or a keyboard/input
 * event from the last few hundred milliseconds, holds the user's value against a tick.
 */
type RangeGuard = { dragging: boolean; interactedAt: number };

type TrackRow = {
  id: string;
  row: HTMLLIElement;
  name: HTMLElement;
  uploader: HTMLElement;
  duration: HTMLElement;
  size: HTMLElement;
  gain: HTMLElement;
  state: HTMLElement;
  current: HTMLElement;
  ended: HTMLElement;
  select: HTMLButtonElement;
  retry: HTMLButtonElement;
  remove: HTMLButtonElement;
};

/**
 * Builds the provisional music panel around a persistent audio controller view.
 *
 * The structure is created once; `update` only rewrites text and state that actually
 * changed. Track rows keep their identity while the ordered id list is unchanged, and the
 * status live region and hints compare before writing so an unchanged view never churns
 * their text nodes.
 */
export function createMusicView(root: HTMLElement, initial: AudioPanelView, actions: AudioActions): MusicView {
  const controller = new AbortController();
  const { signal } = controller;

  const title = el('h2', 'Music');
  title.id = 'music-title';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'music-file';
  fileInput.accept = 'audio/*';
  fileInput.hidden = true;
  fileInput.setAttribute('aria-label', `Audio file up to ${megabytes(AUDIO_BYTES)}`);
  const addButton = el('button', 'Add track');
  addButton.type = 'button';
  addButton.id = 'music-add';
  const addHint = el('span', `Audio files up to ${megabytes(AUDIO_BYTES)}`, 'muted music-hint');
  const addRow = el('div', '', 'music-add');
  addRow.append(addButton, fileInput, addHint);

  const permissionHint = el('p', '', 'muted music-hint');

  const statusLine = el('p');
  statusLine.id = 'music-status';
  statusLine.setAttribute('role', 'status');
  statusLine.setAttribute('aria-live', 'polite');

  const soundSlot = el('div', '', 'music-sound');
  const enableSound = el('button', 'Enable sound');
  enableSound.type = 'button';
  enableSound.id = 'music-enable-sound';
  enableSound.className = 'primary';

  const usage = el('p', '', 'muted music-usage');

  const library = el('ul', '', 'music-tracks');
  library.setAttribute('aria-label', 'Shared music library');
  const emptyItem = el('li', EMPTY_LIBRARY, 'muted music-empty');

  const transportTitle = el('h3', 'Now playing');

  const playButton = el('button', 'Start');
  playButton.type = 'button';
  playButton.id = 'music-play';
  playButton.setAttribute('aria-pressed', 'false');

  const progressField = el('label', 'Track progress', 'music-range');
  progressField.htmlFor = 'music-progress';
  const progress = document.createElement('input');
  progress.type = 'range';
  progress.id = 'music-progress';
  progress.min = '0';
  progress.max = '0';
  progress.step = String(SEEK_STEP_MS);
  progress.value = '0';
  progress.setAttribute('aria-label', 'Track progress');
  progressField.append(progress);

  const time = el('span', '0:00 / 0:00', 'music-time');

  const gainField = el('label', 'Track volume (everyone)', 'music-range');
  gainField.htmlFor = 'music-gain';
  const gain = document.createElement('input');
  gain.type = 'range';
  gain.id = 'music-gain';
  gain.min = '0';
  gain.max = String(GAIN_MAX);
  gain.step = '1';
  gain.value = '100';
  gain.setAttribute('aria-label', 'Track volume (everyone)');
  gainField.append(gain);

  const gainValue = el('span', '100%', 'music-value');

  const localField = el('label', 'Your volume (this device)', 'music-range');
  localField.htmlFor = 'music-local';
  const local = document.createElement('input');
  local.type = 'range';
  local.id = 'music-local';
  local.min = '0';
  local.max = String(LOCAL_MAX);
  local.step = '1';
  local.value = '100';
  local.setAttribute('aria-label', 'Your volume (this device)');
  localField.append(local);

  const localValue = el('span', '100%', 'music-value');

  const controlHint = el('p', '', 'muted music-hint');
  const transport = el('div', '', 'music-transport');
  transport.append(
    transportTitle,
    playButton,
    progressField,
    time,
    gainField,
    gainValue,
    localField,
    localValue,
    controlHint,
  );

  const section = el('section', '', 'music');
  section.setAttribute('aria-labelledby', title.id);
  section.append(
    title,
    addRow,
    permissionHint,
    statusLine,
    soundSlot,
    usage,
    library,
    transport,
  );
  root.replaceChildren(section);

  let current: AudioPanelView = initial;
  let trackKey: string | null = null;
  let rows: TrackRow[] = [];
  const progressGuard: RangeGuard = { dragging: false, interactedAt: 0 };
  const gainGuard: RangeGuard = { dragging: false, interactedAt: 0 };
  const localGuard: RangeGuard = { dragging: false, interactedAt: 0 };

  /** Writes text only when it differs, so an unchanged update keeps the same text node. */
  function setText(node: HTMLElement, text: string): void {
    if (node.textContent !== text) node.textContent = text;
  }

  function held(guard: RangeGuard): boolean {
    return guard.dragging || Date.now() - guard.interactedAt < RECENT_INTERACTION_MS;
  }

  /** Returns the value the user should see: the held one during interaction, else the view's. */
  function syncRange(input: HTMLInputElement, value: number, guard: RangeGuard): number {
    if (held(guard)) {
      const shown = Number(input.value);
      return Number.isFinite(shown) ? shown : value;
    }
    const next = String(value);
    if (input.value !== next) input.value = next;
    return value;
  }

  function renderTime(positionMs: number, durationMs: number): void {
    const duration = Math.max(0, Math.round(durationMs));
    const position = clamp(positionMs, 0, duration);
    setText(time, `${clock(position)} / ${clock(duration)}`);
    progress.setAttribute('aria-valuetext', `${clock(position)} of ${clock(duration)}`);
  }

  function buildRow(track: AudioTrackView): TrackRow {
    const row = el('li', '', 'music-track');
    row.dataset.track = track.id;

    const head = el('div', '', 'music-track-head');
    const name = el('strong', '', 'music-track-name');
    const uploader = el('span', '', 'muted music-track-uploader');
    head.append(name, uploader);

    const meta = el('div', '', 'music-track-meta');
    const duration = el('span', '', 'music-track-duration');
    const size = el('span', '', 'music-track-size');
    const gainLabel = el('span', '', 'music-track-gain');
    const state = el('span', '', 'music-track-state');
    const currentMarker = el('span', '', 'music-track-current');
    const ended = el('span', '', 'music-track-ended');
    meta.append(duration, size, gainLabel, state, currentMarker, ended);

    const rowActions = el('div', '', 'music-track-actions');
    const select = el('button', 'Select');
    select.type = 'button';
    select.dataset.trackSelect = '';
    select.addEventListener('click', () => actions.select(track.id), { signal });
    const retry = el('button', 'Retry download');
    retry.type = 'button';
    retry.dataset.trackRetry = '';
    retry.addEventListener('click', () => { void actions.retry(track.id); }, { signal });
    const remove = el('button', 'Remove');
    remove.type = 'button';
    remove.dataset.trackRemove = '';
    remove.addEventListener('click', () => actions.remove(track.id), { signal });
    rowActions.append(select, retry, remove);

    row.append(head, meta, rowActions);
    return {
      id: track.id,
      row,
      name,
      uploader,
      duration,
      size,
      gain: gainLabel,
      state,
      current: currentMarker,
      ended,
      select,
      retry,
      remove,
    };
  }

  function syncRow(record: TrackRow, track: AudioTrackView, view: AudioPanelView): void {
    setText(record.name, track.name);
    setText(record.uploader, `Added by ${track.addedBy || FORMER_PLAYER}`);
    setText(record.duration, clock(track.durationMs));
    setText(record.size, fileSize(track.size));
    setText(record.gain, `Shared gain ${clamp(track.gain, 0, GAIN_MAX)}%`);
    setText(record.state, availability(track));
    setText(record.current, track.current ? 'Current track' : '');
    setText(record.ended, track.ended ? 'Ended' : '');
    // Availability is not a reason to block a selection: making a peer-only track current
    // is what lets the controller fetch it locally.
    record.select.disabled = !view.canControl || track.current;
    setText(record.select, track.current ? 'Current' : 'Select');
    record.select.setAttribute('aria-pressed', String(track.current));
    record.select.setAttribute('aria-label', track.current ? `${track.name} is the current track` : `Select ${track.name}`);
    record.retry.hidden = !(track.current && !track.available && !track.downloading);
    record.retry.disabled = !view.canControl;
    record.retry.setAttribute('aria-label', `Retry download for ${track.name}`);
    record.remove.disabled = !view.canRemove;
    record.remove.setAttribute('aria-label', `Remove ${track.name}`);
  }

  function renderTracks(view: AudioPanelView): void {
    const key = view.tracks.map((track) => track.id).join('|');
    if (key !== trackKey) {
      trackKey = key;
      rows = view.tracks.map(buildRow);
      library.replaceChildren(...(rows.length ? rows.map((record) => record.row) : [emptyItem]));
    }
    for (let index = 0; index < view.tracks.length; index++) {
      const track = view.tracks[index];
      const record = rows[index];
      if (track !== undefined && record !== undefined && record.id === track.id) syncRow(record, track, view);
    }
  }

  function apply(view: AudioPanelView): void {
    current = view;
    const currentTrack = view.tracks.find((track) => track.id === view.currentTrackId) ?? null;
    const ready = currentTrack !== null && currentTrack.available;

    setText(playButton, view.playing ? 'Stop' : 'Start');
    playButton.setAttribute('aria-pressed', String(view.playing));
    playButton.disabled = !view.canControl || !ready;
    playButton.setAttribute('aria-label', view.playing ? 'Stop shared playback' : 'Start shared playback');

    const duration = Math.max(0, Math.round(view.durationMs));
    const max = String(duration);
    if (progress.max !== max) progress.max = max;
    const shownPosition = syncRange(progress, clamp(view.positionMs, 0, duration), progressGuard);
    progress.disabled = !view.canControl || !ready;
    renderTime(shownPosition, duration);

    const shownGain = clamp(syncRange(gain, clamp(view.gain, 0, GAIN_MAX), gainGuard), 0, GAIN_MAX);
    gain.disabled = !view.canControl || !ready;
    setText(gainValue, `${shownGain}%`);

    const shownLocal = clamp(syncRange(local, clamp(view.localVolume, 0, LOCAL_MAX), localGuard), 0, LOCAL_MAX);
    setText(localValue, `${shownLocal}%`);

    addButton.disabled = !view.canAdd;
    fileInput.disabled = !view.canAdd;
    setText(usage, `Using ${fileSize(view.usageBytes)} of ${megabytes(AUDIO_BYTES)}`);

    const permissionParts: string[] = [];
    if (!view.canAdd) permissionParts.push('Choose your player before adding music.');
    if (!view.canRemove) permissionParts.push('Choose your player before removing tracks.');
    setText(permissionHint, permissionParts.join(' '));

    let controlReason = '';
    if (!view.connected) controlReason = 'Connect to the room to control playback.';
    else if (!view.canControl) controlReason = 'Choose your player to control playback.';
    else if (currentTrack === null) controlReason = 'Add or select a track to use the transport.';
    else if (!currentTrack.available) {
      controlReason = currentTrack.downloading
        ? 'This track is still downloading.'
        : 'This track’s file is not available here yet; use Retry download.';
    }
    setText(controlHint, controlReason);

    const notices: string[] = [];
    if (!view.connected) notices.push('Connect to the room to play music with everyone.');
    if (view.needsSound) notices.push('This browser blocked the sound; use Enable sound to start it.');
    if (view.status) notices.push(view.status);
    setText(statusLine, notices.join(' '));

    if (view.needsSound) {
      if (enableSound.parentNode !== soundSlot) soundSlot.append(enableSound);
    } else {
      enableSound.remove();
    }

    renderTracks(view);
  }

  // ── range interaction guards ───────────────────────────────────────────────────────
  // Pointer drags hold the slider value against controller ticks; keyboard/input events
  // hold it briefly. Blur always resyncs from the latest view so the user never keeps a
  // stale value after leaving the control.
  function guardRange(input: HTMLInputElement, state: RangeGuard): void {
    input.addEventListener('pointerdown', () => {
      state.dragging = true;
      state.interactedAt = 0;
    }, { signal });
    input.addEventListener('pointerup', () => {
      state.dragging = false;
      state.interactedAt = 0;
    }, { signal });
    input.addEventListener('pointercancel', () => {
      state.dragging = false;
      state.interactedAt = 0;
    }, { signal });
    input.addEventListener('input', () => {
      if (!state.dragging) state.interactedAt = Date.now();
    }, { signal });
    input.addEventListener('blur', () => {
      state.dragging = false;
      state.interactedAt = 0;
      apply(current);
    }, { signal });
  }

  guardRange(progress, progressGuard);
  guardRange(gain, gainGuard);
  guardRange(local, localGuard);

  playButton.addEventListener('click', () => actions.toggle(), { signal });

  progress.addEventListener('input', () => {
    const shown = Number(progress.value);
    renderTime(Number.isFinite(shown) ? shown : 0, current.durationMs);
  }, { signal });
  progress.addEventListener('change', () => {
    progressGuard.dragging = false;
    progressGuard.interactedAt = 0;
    actions.seek(Number(progress.value));
  }, { signal });

  // Shared gain is previewed locally while dragging and committed once on release.
  gain.addEventListener('input', () => {
    const preview = clamp(Number(gain.value), 0, GAIN_MAX);
    setText(gainValue, `${preview}%`);
  }, { signal });
  gain.addEventListener('change', () => {
    gainGuard.dragging = false;
    gainGuard.interactedAt = 0;
    actions.setGain(Number(gain.value));
  }, { signal });

  // Device volume stays local and immediate.
  local.addEventListener('input', () => {
    const preview = clamp(Number(local.value), 0, LOCAL_MAX);
    setText(localValue, `${preview}%`);
    actions.setLocalVolume(Number(local.value));
  }, { signal });

  enableSound.addEventListener('click', () => { void actions.enableSound(); }, { signal });
  addButton.addEventListener('click', () => fileInput.click(), { signal });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0] ?? null;
    fileInput.value = '';
    if (file) void actions.add(file);
  }, { signal });

  apply(initial);

  return {
    update(view: AudioPanelView): void {
      apply(view);
    },
    destroy(): void {
      controller.abort();
      root.replaceChildren();
    },
  };
}
