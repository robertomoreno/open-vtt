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
  remove: HTMLButtonElement;
};

/**
 * Builds the provisional music panel around a persistent audio controller view.
 *
 * The structure is created once; `update` only rewrites the text and disabled state of the
 * existing nodes. Track rows keep their identity while the ordered id list is unchanged,
 * and a range that has focus is never rewritten, so a pointer drag is not interrupted by
 * the controller's tick notifications.
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

  let trackKey: string | null = null;
  let rows: TrackRow[] = [];

  /** Writes a range's value only while the user is not interacting with it. */
  function setRange(input: HTMLInputElement, value: number): void {
    if (document.activeElement === input) return;
    const next = String(value);
    if (input.value !== next) input.value = next;
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
    const current = el('span', '', 'music-track-current');
    const ended = el('span', '', 'music-track-ended');
    meta.append(duration, size, gainLabel, state, current, ended);

    const rowActions = el('div', '', 'music-track-actions');
    const select = el('button', 'Play');
    select.type = 'button';
    select.dataset.trackSelect = '';
    select.addEventListener('click', () => actions.select(track.id), { signal });
    const remove = el('button', 'Remove');
    remove.type = 'button';
    remove.dataset.trackRemove = '';
    remove.addEventListener('click', () => actions.remove(track.id), { signal });
    rowActions.append(select, remove);

    row.append(head, meta, rowActions);
    return { id: track.id, row, name, uploader, duration, size, gain: gainLabel, state, current, ended, select, remove };
  }

  function syncRow(record: TrackRow, track: AudioTrackView, view: AudioPanelView): void {
    record.name.textContent = track.name;
    record.uploader.textContent = `Added by ${track.addedBy || FORMER_PLAYER}`;
    record.duration.textContent = clock(track.durationMs);
    record.size.textContent = fileSize(track.size);
    record.gain.textContent = `Shared gain ${clamp(track.gain, 0, GAIN_MAX)}%`;
    record.state.textContent = availability(track);
    record.current.textContent = track.current ? 'Current track' : '';
    record.ended.textContent = track.ended ? 'Ended' : '';
    record.select.disabled = !view.canControl || track.current || !track.available;
    record.select.textContent = track.current ? 'Selected' : 'Play';
    record.select.setAttribute('aria-pressed', String(track.current));
    record.select.setAttribute('aria-label', track.current ? `${track.name} is the current track` : `Play ${track.name}`);
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
    const current = view.tracks.find((track) => track.id === view.currentTrackId) ?? null;
    const ready = current !== null && current.available;

    playButton.textContent = view.playing ? 'Stop' : 'Start';
    playButton.setAttribute('aria-pressed', String(view.playing));
    playButton.disabled = !view.canControl || !ready;
    playButton.setAttribute('aria-label', view.playing ? 'Stop shared playback' : 'Start shared playback');

    const duration = Math.max(0, Math.round(view.durationMs));
    const position = clamp(view.positionMs, 0, duration);
    progress.max = String(duration);
    setRange(progress, position);
    progress.disabled = !view.canControl || !ready;
    progress.setAttribute('aria-valuetext', `${clock(position)} of ${clock(duration)}`);
    time.textContent = `${clock(position)} / ${clock(duration)}`;

    const gainValueNumber = clamp(view.gain, 0, GAIN_MAX);
    setRange(gain, gainValueNumber);
    gain.disabled = !view.canControl || !ready;
    gainValue.textContent = `${gainValueNumber}%`;

    const localValueNumber = clamp(view.localVolume, 0, LOCAL_MAX);
    setRange(local, localValueNumber);
    localValue.textContent = `${localValueNumber}%`;

    addButton.disabled = !view.canAdd;
    fileInput.disabled = !view.canAdd;
    usage.textContent = `Using ${fileSize(view.usageBytes)} of ${megabytes(AUDIO_BYTES)}`;

    const permissionParts: string[] = [];
    if (!view.canAdd) permissionParts.push('Choose your player before adding music.');
    if (!view.canRemove) permissionParts.push('Choose your player before removing tracks.');
    permissionHint.textContent = permissionParts.join(' ');

    let controlReason = '';
    if (!view.connected) controlReason = 'Connect to the room to control playback.';
    else if (!view.canControl) controlReason = 'Only the host can control playback.';
    else if (current === null) controlReason = 'Add or select a track to use the transport.';
    else if (!current.available) {
      controlReason = current.downloading
        ? 'This track is still downloading.'
        : 'This track is not available in this room yet.';
    }
    controlHint.textContent = controlReason;

    const notices: string[] = [];
    if (!view.connected) notices.push('Connect to the room to play music with everyone.');
    if (view.needsSound) notices.push('This browser blocked the sound; use Enable sound to start it.');
    if (view.status) notices.push(view.status);
    statusLine.textContent = notices.join(' ');

    if (view.needsSound) {
      if (enableSound.parentNode !== soundSlot) soundSlot.append(enableSound);
    } else {
      enableSound.remove();
    }

    renderTracks(view);
  }

  playButton.addEventListener('click', () => actions.toggle(), { signal });
  progress.addEventListener('change', () => actions.seek(Number(progress.value)), { signal });
  const commitGain = (): void => actions.setGain(Number(gain.value));
  gain.addEventListener('input', commitGain, { signal });
  gain.addEventListener('change', commitGain, { signal });
  local.addEventListener('input', () => actions.setLocalVolume(Number(local.value)), { signal });
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
