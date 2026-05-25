import type { CaptionMessage, StoredData } from './types';

const LANGUAGES: ReadonlyArray<readonly [code: string, label: string]> = [
  ['en', 'English'],
  ['pl', 'Polish'],
  ['uk', 'Ukrainian'],
  ['ru', 'Russian'],
  ['de', 'German'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['sv', 'Swedish'],
  ['no', 'Norwegian'],
  ['da', 'Danish'],
  ['fi', 'Finnish'],
  ['cs', 'Czech'],
  ['hu', 'Hungarian'],
  ['ro', 'Romanian'],
  ['sk', 'Slovak'],
  ['tr', 'Turkish'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh', 'Chinese'],
  ['ar', 'Arabic'],
  ['he', 'Hebrew'],
];

const STORAGE_KEY = 'data';
const DEFAULT_LANGUAGE = 'en';
const DEFAULT_AUTO_ENABLE = true;

const emptyData = (): StoredData => ({
  meetings: {},
  defaultLanguage: DEFAULT_LANGUAGE,
  autoEnableCaptions: DEFAULT_AUTO_ENABLE,
});

const picker = document.getElementById('meeting-picker') as HTMLSelectElement;
const langPicker = document.getElementById('language-picker') as HTMLSelectElement;
const autoEnableEl = document.getElementById('auto-enable') as HTMLInputElement;
const captionsEl = document.getElementById('captions') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;
const clearBtn = document.getElementById('clear') as HTMLButtonElement;

let selectedMeetingId: string | null = null;

langPicker.innerHTML = LANGUAGES.map(
  ([code, label]) => `<option value="${code}">${label}</option>`,
).join('');

const load = async (): Promise<StoredData> => {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] ?? emptyData();
};

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const sendMessage = (msg: CaptionMessage) => {
  const p = chrome.runtime.sendMessage(msg);
  if (p && typeof (p as Promise<unknown>).catch === 'function') {
    (p as Promise<unknown>).catch(() => undefined);
  }
};

const render = (data: StoredData) => {
  autoEnableEl.checked = data.autoEnableCaptions ?? DEFAULT_AUTO_ENABLE;
  const meetings = Object.values(data.meetings).sort((a, b) => b.startedAt - a.startedAt);

  if (meetings.length === 0) {
    picker.innerHTML = '<option>(no meetings yet)</option>';
    picker.disabled = true;
    langPicker.value = data.defaultLanguage ?? DEFAULT_LANGUAGE;
    captionsEl.innerHTML =
      '<div class="empty">Join a Google Meet and turn on captions to see live transcript here. Language above is the default for new meetings.</div>';
    statusEl.textContent = '';
    return;
  }

  picker.disabled = false;

  if (!selectedMeetingId || !data.meetings[selectedMeetingId]) {
    selectedMeetingId = meetings[0]!.meetingId;
  }

  picker.innerHTML = meetings
    .map((m) => {
      const platformLabel = m.platform === 'zoom' ? 'Zoom' : 'Meet';
      return `<option value="${m.meetingId}" ${m.meetingId === selectedMeetingId ? 'selected' : ''}>${platformLabel} — ${m.meetingId} — ${fmtTime(m.startedAt)}</option>`;
    })
    .join('');

  const meeting = data.meetings[selectedMeetingId]!;
  langPicker.value = meeting.language ?? data.defaultLanguage ?? DEFAULT_LANGUAGE;

  const rows = Object.values(meeting.captions).sort((a, b) => a.startedAt - b.startedAt);

  if (rows.length === 0) {
    captionsEl.innerHTML = '<div class="empty">Meeting registered, waiting for captions…</div>';
  } else {
    captionsEl.innerHTML = rows
      .map((r) => {
        const cls = r.finalized ? 'row' : 'row live';
        return `<div class="${cls}"><span class="speaker">${escapeHtml(r.speaker)}:</span> <span class="text">${escapeHtml(r.text)}</span></div>`;
      })
      .join('');
    captionsEl.scrollTop = captionsEl.scrollHeight;
  }

  statusEl.textContent = `${rows.length} caption${rows.length === 1 ? '' : 's'}`;
};

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

picker.addEventListener('change', () => {
  selectedMeetingId = picker.value;
  void load().then(render);
});

langPicker.addEventListener('change', () => {
  const language = langPicker.value;
  if (selectedMeetingId) {
    sendMessage({ kind: 'set-meeting-language', meetingId: selectedMeetingId, language });
  } else {
    sendMessage({ kind: 'set-default-language', language });
  }
});

autoEnableEl.addEventListener('change', () => {
  sendMessage({ kind: 'set-auto-enable', enabled: autoEnableEl.checked });
});

clearBtn.addEventListener('click', async () => {
  if (!confirm('Delete all stored transcripts?')) return;
  await chrome.storage.local.remove(STORAGE_KEY);
  selectedMeetingId = null;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE_KEY]) return;
  const next = (changes[STORAGE_KEY].newValue as StoredData | undefined) ?? emptyData();
  render(next);
});

void load().then(render);
