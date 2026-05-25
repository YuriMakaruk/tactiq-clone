import type { CaptionMessage, StoredData } from './types';

const STORAGE_KEY = 'data';
const DEFAULT_LANGUAGE = 'en';
const DEFAULT_AUTO_ENABLE = true;

let writeChain: Promise<void> = Promise.resolve();

const mutate = (fn: (data: StoredData) => StoredData): Promise<void> => {
  writeChain = writeChain.then(async () => {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const current: StoredData = stored[STORAGE_KEY] ?? {
      meetings: {},
      defaultLanguage: DEFAULT_LANGUAGE,
      autoEnableCaptions: DEFAULT_AUTO_ENABLE,
    };
    if (!current.defaultLanguage) current.defaultLanguage = DEFAULT_LANGUAGE;
    if (typeof current.autoEnableCaptions !== 'boolean') {
      current.autoEnableCaptions = DEFAULT_AUTO_ENABLE;
    }
    const next = fn(current);
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
  });
  return writeChain;
};

const handle = (msg: CaptionMessage): void => {
  if (msg.kind === 'meeting-started') {
    void mutate((data) => {
      const existing = data.meetings[msg.meetingId];
      if (!existing) {
        data.meetings[msg.meetingId] = {
          meetingId: msg.meetingId,
          url: msg.url,
          startedAt: msg.startedAt,
          language: data.defaultLanguage,
          platform: msg.platform,
          captions: {},
        };
      } else if (!existing.platform) {
        existing.platform = msg.platform;
      }
      return data;
    });
    return;
  }

  if (msg.kind === 'caption-update') {
    void mutate((data) => {
      const meeting =
        data.meetings[msg.record.meetingId] ??
        (data.meetings[msg.record.meetingId] = {
          meetingId: msg.record.meetingId,
          url: '',
          startedAt: msg.record.startedAt,
          language: data.defaultLanguage,
          platform: 'meet',
          captions: {},
        });
      meeting.captions[msg.record.id] = msg.record;
      return data;
    });
    return;
  }

  if (msg.kind === 'caption-finalize') {
    void mutate((data) => {
      const meeting = data.meetings[msg.meetingId];
      const caption = meeting?.captions[msg.id];
      if (caption) {
        caption.finalized = true;
        caption.updatedAt = msg.finalizedAt;
      }
      return data;
    });
    return;
  }

  if (msg.kind === 'set-meeting-language') {
    void mutate((data) => {
      const meeting = data.meetings[msg.meetingId];
      if (meeting) meeting.language = msg.language;
      data.defaultLanguage = msg.language;
      return data;
    });
    return;
  }

  if (msg.kind === 'set-default-language') {
    void mutate((data) => {
      data.defaultLanguage = msg.language;
      return data;
    });
    return;
  }

  if (msg.kind === 'set-auto-enable') {
    void mutate((data) => {
      data.autoEnableCaptions = msg.enabled;
      return data;
    });
    return;
  }
};

chrome.runtime.onMessage.addListener((msg: CaptionMessage) => {
  try {
    handle(msg);
  } catch (e) {
    console.error('[tactiq-clone bg] handler error', e);
  }
});
