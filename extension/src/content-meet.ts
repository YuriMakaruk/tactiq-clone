// Google Meet caption scraper. Runs as a classic content script (no module syntax).
// The captions container only exists when the user has turned CC on.

const PREFIX = '[tactiq-clone]';
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
  const m = location.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  return m?.[1] ?? `unknown-${Date.now().toString(36)}`;
};

const findCaptionsContainer = (): HTMLElement | null => {
  const selectors = [
    'div[role="region"][aria-label*="Captions" i]',
    'div[aria-label*="caption" i]',
    'div.a4cQT',
  ];
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
};

const rowStates = new WeakMap<Element, RowState>();
const activeRows = new Set<Element>();

const generateId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Speaker name lives in a small child element; caption text is the rest.
// These class fragments are Meet-specific and will need updating when Google ships UI changes.
const NAME_SELECTORS = ['[class*="zs7s8d"]', '[class*="KvF4xc"]', '[class*="NWpY1d"]'];

const extractCaption = (row: Element): { speaker: string; text: string } | null => {
  const allText = (row.textContent ?? '').trim();
  if (!allText) return null;

  let speaker = 'Unknown';
  for (const sel of NAME_SELECTORS) {
    const nameEl = row.querySelector(sel);
    const nameText = nameEl?.textContent?.trim();
    if (nameText && nameText.length < 80) {
      speaker = nameText;
      break;
    }
  }

  let text = allText;
  if (speaker !== 'Unknown' && text.startsWith(speaker)) {
    text = text.slice(speaker.length).trim();
  }
  return { speaker, text };
};

const send = (msg: unknown) => {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof (p as Promise<unknown>).catch === 'function') {
      (p as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    // ignore: background may not be ready
  }
};

const meetingId = meetingIdFromUrl();
let meetingAnnounced = false;

const announceMeeting = () => {
  if (meetingAnnounced) return;
  meetingAnnounced = true;
  send({ kind: 'meeting-started', meetingId, url: location.href, startedAt: Date.now() });
  log('meeting announced:', meetingId);
};

const FINALIZE_AFTER_MS = 5000;

let autoEnableEnabled = true;
let autoEnableAttempts = 0;
let autoEnableDone = false;
const AUTO_ENABLE_MAX_ATTEMPTS = 6;

chrome.storage.local.get('data').then((stored) => {
  const data = stored.data;
  if (data && typeof data.autoEnableCaptions === 'boolean') {
    autoEnableEnabled = data.autoEnableCaptions;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.data) return;
  const next = changes.data.newValue;
  if (next && typeof next.autoEnableCaptions === 'boolean') {
    autoEnableEnabled = next.autoEnableCaptions;
  }
});

const isVisible = (el: HTMLElement): boolean => {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
};

const findButtons = (predicate: (label: string) => boolean): HTMLElement[] => {
  const matches: HTMLElement[] = [];
  for (const btn of Array.from(document.querySelectorAll<HTMLElement>('button[aria-label]'))) {
    if (btn.closest('[role="dialog"], [role="menu"]')) continue;
    if (!isVisible(btn)) continue;
    const label = (btn.getAttribute('aria-label') ?? '').toLowerCase();
    if (predicate(label)) matches.push(btn);
  }
  return matches;
};

const isInCall = (): boolean =>
  findButtons(
    (l) => l.includes('leave call') || l.includes('hang up') || l.includes('end call'),
  ).length > 0;

const isCaptionsAlreadyOn = (): boolean => {
  if (findCaptionsContainer()) return true;
  return findButtons((l) => l.includes('turn off') && l.includes('caption')).length > 0;
};

const findEnableCaptionsButton = (): HTMLElement | null => {
  const candidates = findButtons((l) => l.includes('turn on') && l.includes('caption'));
  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom,
  );
  return candidates[0] ?? null;
};

let captionsClickedAt = 0;
let lastDialogLogged: HTMLElement | null = null;
let pendingDismissCheck: { dialog: HTMLElement; clickedAt: number; escTried: boolean } | null = null;
const DIALOG_GRACE_MS = 15000;
const CONFIRM_PATTERNS = ['apply', 'confirm', 'done', 'start captions', 'start', 'got it', 'save', 'continue', 'ok'];
const DISMISS_PATTERNS = ['close', 'dismiss', 'not now', 'cancel'];

const findVisibleDialogs = (): HTMLElement[] => {
  const all = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'));
  return all.filter(isVisible);
};

const matchesAny = (str: string, patterns: readonly string[]): boolean => {
  for (const pat of patterns) {
    if (str === pat || str.includes(pat)) return true;
  }
  return false;
};

const findActionButton = (dialog: HTMLElement, patterns: readonly string[]): HTMLElement | null => {
  for (const btn of Array.from(dialog.querySelectorAll<HTMLElement>('button'))) {
    if (!isVisible(btn)) continue;
    const text = (btn.textContent ?? '').trim().toLowerCase();
    const label = (btn.getAttribute('aria-label') ?? '').toLowerCase();
    if (matchesAny(text, patterns) || matchesAny(label, patterns)) return btn;
  }
  return null;
};

const logDialogShape = (dialog: HTMLElement) => {
  if (lastDialogLogged === dialog) return;
  lastDialogLogged = dialog;
  const heading = dialog.querySelector('h1,h2,h3,[role="heading"]')?.textContent?.trim();
  log('dialog appeared. heading:', heading ?? '(none)');
  const buttons = Array.from(dialog.querySelectorAll<HTMLElement>('button')).filter(isVisible);
  for (const btn of buttons) {
    log('  button:', JSON.stringify(btn.textContent?.trim() ?? ''), 'aria-label:', JSON.stringify(btn.getAttribute('aria-label') ?? ''));
  }
};

const synthesizeEsc = () => {
  for (const target of [document, document.body] as const) {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
  }
};

const tryDismissLanguageDialog = () => {
  if (pendingDismissCheck) {
    const { dialog, clickedAt, escTried } = pendingDismissCheck;
    const stillVisible = document.contains(dialog) && isVisible(dialog);
    if (!stillVisible) {
      log('dialog closed successfully');
      pendingDismissCheck = null;
      captionsClickedAt = 0;
      return;
    }
    if (Date.now() - clickedAt > 2000 && !escTried) {
      log('dialog still visible after click, trying ESC');
      synthesizeEsc();
      pendingDismissCheck.escTried = true;
      return;
    }
    if (Date.now() - clickedAt > 5000) {
      log('dialog stubborn, giving up auto-dismiss — close it manually');
      pendingDismissCheck = null;
      captionsClickedAt = 0;
      return;
    }
    return;
  }

  if (!captionsClickedAt) return;
  if (Date.now() - captionsClickedAt > DIALOG_GRACE_MS) {
    captionsClickedAt = 0;
    lastDialogLogged = null;
    return;
  }
  const dialogs = findVisibleDialogs();
  if (dialogs.length === 0) return;
  const dialog = dialogs[dialogs.length - 1]!;
  logDialogShape(dialog);

  const confirmBtn = findActionButton(dialog, CONFIRM_PATTERNS);
  if (confirmBtn) {
    log('clicking confirm button:', JSON.stringify(confirmBtn.textContent?.trim()));
    confirmBtn.click();
    pendingDismissCheck = { dialog, clickedAt: Date.now(), escTried: false };
    return;
  }

  const dismissBtn = findActionButton(dialog, DISMISS_PATTERNS);
  if (dismissBtn) {
    log('clicking dismiss button:', JSON.stringify(dismissBtn.textContent?.trim()), 'aria:', JSON.stringify(dismissBtn.getAttribute('aria-label')));
    dismissBtn.click();
    pendingDismissCheck = { dialog, clickedAt: Date.now(), escTried: false };
    return;
  }

  log('no recognizable button in dialog, sending ESC');
  synthesizeEsc();
  pendingDismissCheck = { dialog, clickedAt: Date.now(), escTried: true };
};

const tryAutoEnableCaptions = () => {
  if (autoEnableDone || !autoEnableEnabled) return;
  if (autoEnableAttempts >= AUTO_ENABLE_MAX_ATTEMPTS) return;
  if (!isInCall()) return;
  if (isCaptionsAlreadyOn()) {
    autoEnableDone = true;
    log('captions already on, skipping auto-enable');
    return;
  }
  const btn = findEnableCaptionsButton();
  if (!btn) {
    autoEnableAttempts++;
    return;
  }
  autoEnableAttempts++;
  log(`auto-enabling captions (attempt ${autoEnableAttempts})`);
  btn.click();
  captionsClickedAt = Date.now();
};


const isUiControl = (row: Element): boolean => {
  if (row.tagName === 'BUTTON') return true;
  const role = row.getAttribute('role');
  if (role && ['button', 'menuitem', 'tab', 'link'].includes(role)) return true;
  if (row.querySelector('button, [role="button"]')) {
    const text = (row.textContent ?? '').trim();
    if (text.length < 80) return true;
  }
  const text = (row.textContent ?? '').trim();
  if (/^[a-z_]{4,}[A-Z]/.test(text)) return true;
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
  for (const child of Array.from(container.children)) {
    updateRow(child);
  }
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
  tryAutoEnableCaptions();
  tryDismissLanguageDialog();
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

(window as unknown as { __tactiqDialogProbe: () => void }).__tactiqDialogProbe = () => {
  const dialogs = findVisibleDialogs();
  console.group(`${PREFIX} dialog probe`);
  console.log('visible dialogs:', dialogs.length);
  dialogs.forEach((d, i) => {
    const heading = d.querySelector('h1,h2,h3,[role="heading"]')?.textContent?.trim();
    console.group(`dialog #${i} — heading: ${heading ?? '(none)'}`);
    console.log('element:', d);
    console.log('text (first 300):', (d.textContent ?? '').slice(0, 300));
    const buttons = Array.from(d.querySelectorAll('button')).filter((b) => isVisible(b as HTMLElement));
    console.log('buttons:');
    for (const b of buttons) {
      console.log('  ', JSON.stringify(b.textContent?.trim() ?? ''), '|', JSON.stringify(b.getAttribute('aria-label') ?? ''));
    }
    console.groupEnd();
  });
  console.groupEnd();
};

(window as unknown as { __tactiqProbe: () => void }).__tactiqProbe = () => {
  const container = findCaptionsContainer();
  console.group(`${PREFIX} probe`);
  console.log('meetingId:', meetingId);
  console.log('container:', container);
  if (container) {
    console.log('children count:', container.children.length);
    console.log('innerHTML preview:', container.innerHTML.slice(0, 1500));
  } else {
    console.log('No captions container. Turn on CC in the Meet UI.');
  }
  console.groupEnd();
};
