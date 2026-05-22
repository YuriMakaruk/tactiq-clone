export type CaptionRecord = {
  id: string;
  meetingId: string;
  speaker: string;
  text: string;
  startedAt: number;
  updatedAt: number;
  finalized: boolean;
};

export type StoredMeeting = {
  meetingId: string;
  url: string;
  startedAt: number;
  language: string;
  captions: Record<string, CaptionRecord>;
};

export type StoredData = {
  meetings: Record<string, StoredMeeting>;
  defaultLanguage: string;
  autoEnableCaptions: boolean;
};

export type CaptionMessage =
  | { kind: 'caption-update'; record: CaptionRecord }
  | { kind: 'caption-finalize'; id: string; meetingId: string; finalizedAt: number }
  | { kind: 'meeting-started'; meetingId: string; url: string; startedAt: number }
  | { kind: 'set-meeting-language'; meetingId: string; language: string }
  | { kind: 'set-default-language'; language: string }
  | { kind: 'set-auto-enable'; enabled: boolean };
