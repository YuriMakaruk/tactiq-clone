// Zoom Web Client caption scraper. Classic content script (no module syntax).
// Captions appear when the host enables them and the local user has CC visible.

const zoomTranscriber = (() => {
const PREFIX = '[tactiq-clone zoom]';
const log = (...args: unknown[]) => console.log(PREFIX, ...args);

type RowState = {
  id: string;
  speaker: string;
  text: string;
  startedAt: number;
  updatedAt: number;
  finalized: boolean;
};

const meetingIdFromUrl = (): string => {
  const m = location.pathname.match(/\/wc\/(\d+)/);
  return m?.[1] ?? `unknown-${Date.now().toString(36)}`;
};

const CONTAINER_SELECTORS = [
  '[aria-label*="Captions" i]',
  '[aria-label*="caption" i]',
  '[aria-label*="Closed captions" i]',
  '[aria-label*="live transcript" i]',
  '[class*="live-transcription" i]',
  '[class*="LiveTranscriptionSubtitle" i]',
  '[class*="closed-caption" i]',
  '[class*="closedCaption" i]',
  '[class*="caption-container" i]',
];

const findCaptionsContainer = (): HTMLElement | null => {
  for (const sel of CONTAINER_SELECTORS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
};

const SPEAKER_SELECTORS = [
  '[class*="speaker" i]',
  '[class*="username" i]',
  '[class*="participant-name" i]',
  '[class*="userName" i]',
];

const extractCaption = (row: Element): { speaker: string; text: string } | null => {
  const allText = (row.textContent ?? '').trim();
  if (!allText) return null;

  let speaker = 'Unknown';
  let text = allText;

  for (const sel of SPEAKER_SELECTORS) {
    const nameEl = row.querySelector(sel);
    const nameText = nameEl?.textContent?.trim();
    if (nameText && nameText.length < 80) {
      speaker = nameText;
      if (text.startsWith(speaker)) text = text.slice(speaker.length).trim();
      break;
    }
  }

  if (speaker === 'Unknown') {
    // Fallback: Zoom often renders "Name: text" inline.
    const colonIdx = text.indexOf(':');
    if (colonIdx > 0 && colonIdx < 60) {
      const maybeName = text.slice(0, colonIdx).trim();
      if (maybeName && !/\s{3,}/.test(maybeName)) {
        speaker = maybeName;
        text = text.slice(colonIdx + 1).trim();
      }
    }
  }

  if (text.startsWith(':')) text = text.slice(1).trim();
  if (!text) return null;
  return { speaker, text };
};

const rowStates = new WeakMap<Element, RowState>();
const activeRows = new Set<Element>();

const generateId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const send = (msg: unknown) => {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof (p as Promise<unknown>).catch === 'function') {
      (p as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    // background may not be ready
  }
};

const meetingId = meetingIdFromUrl();
let meetingAnnounced = false;

const announceMeeting = () => {
  if (meetingAnnounced) return;
  meetingAnnounced = true;
  send({
    kind: 'meeting-started',
    meetingId,
    url: location.href,
    startedAt: Date.now(),
    platform: 'zoom',
  });
  log('meeting announced:', meetingId);
};

const FINALIZE_AFTER_MS = 5000;

const isUiControl = (row: Element): boolean => {
  if (row.tagName === 'BUTTON') return true;
  const role = row.getAttribute('role');
  if (role && ['button', 'menuitem', 'tab', 'link'].includes(role)) return true;
  if (row.querySelector('button, [role="button"]')) {
    const text = (row.textContent ?? '').trim();
    if (text.length < 80) return true;
  }
  return false;
};

const updateRow = (row: Element) => {
  if (isUiControl(row)) return;
  const extracted = extractCaption(row);
  if (!extracted || !extracted.text) return;
  const now = Date.now();
  const prev = rowStates.get(row);

  if (!prev) {
    const state: RowState = {
      id: generateId(),
      speaker: extracted.speaker,
      text: extracted.text,
      startedAt: now,
      updatedAt: now,
      finalized: false,
    };
    rowStates.set(row, state);
    activeRows.add(row);
    announceMeeting();
    send({ kind: 'caption-update', record: { ...state, meetingId } });
    log('new:', state.speaker, '—', state.text);
  } else if (prev.text !== extracted.text || prev.speaker !== extracted.speaker) {
    prev.speaker = extracted.speaker;
    prev.text = extracted.text;
    prev.updatedAt = now;
    send({ kind: 'caption-update', record: { ...prev, meetingId } });
  }
};

const scanContainer = (container: HTMLElement) => {
  // Zoom often nests captions a couple levels deep. Walk shallowly and pick
  // leaf-ish nodes with non-trivial text.
  const candidates: Element[] = [];
  const visit = (el: Element, depth: number) => {
    if (depth > 4) return;
    const text = (el.textContent ?? '').trim();
    if (!text) return;
    const hasTextOnlyLeaf =
      el.children.length === 0 ||
      Array.from(el.children).every((c) => (c.textContent ?? '').trim().length < text.length);
    if (hasTextOnlyLeaf && text.length > 0 && text.length < 2000) {
      candidates.push(el);
      return;
    }
    for (const child of Array.from(el.children)) visit(child, depth + 1);
  };
  visit(container, 0);
  for (const el of candidates) updateRow(el);
};

let observer: MutationObserver | null = null;
let observedContainer: HTMLElement | null = null;

const startObserving = (container: HTMLElement) => {
  log('captions container found, observing');
  observedContainer = container;
  observer?.disconnect();
  observer = new MutationObserver(() => scanContainer(container));
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  scanContainer(container);
};

const tick = () => {
  const container = findCaptionsContainer();
  if (container && container !== observedContainer) {
    startObserving(container);
  } else if (!container && observedContainer) {
    log('captions container disappeared');
    observer?.disconnect();
    observer = null;
    observedContainer = null;
  }

  const now = Date.now();
  for (const row of activeRows) {
    const state = rowStates.get(row);
    if (state && !state.finalized && now - state.updatedAt > FINALIZE_AFTER_MS) {
      state.finalized = true;
      send({ kind: 'caption-finalize', id: state.id, meetingId, finalizedAt: now });
      activeRows.delete(row);
    }
  }
};

setInterval(tick, 1500);
tick();

log('content script loaded for meeting', meetingId);

// Attach probe to window while inside IIFE scope
(window as any).__tactiqZoomProbe = () => {
  console.group(`${PREFIX} probe`);
  console.log('meetingId:', meetingId);
  console.log('url:', location.href);
  console.log('Testing selectors...');
  for (const sel of CONTAINER_SELECTORS) {
    const matches = document.querySelectorAll(sel);
    if (matches.length > 0) {
      console.log(`✓ "${sel}" matched ${matches.length} element(s):`, matches[0]);
    }
  }
  const container = findCaptionsContainer();
  console.log('chosen container:', container);
  if (container) {
    console.log('✓ Container found! Children:', container.children.length);
  } else {
    console.log('✗ No container matched. Turn CC ON in Zoom UI first.');
  }
  console.groupEnd();
};

console.log('[tactiq-clone zoom] probe attached to window. Run: __tactiqZoomProbe()');

return { meetingId, PREFIX };
})();
