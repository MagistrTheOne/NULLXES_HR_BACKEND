export const allowedJobAiTransitions = {
  pending: ["received", "canceled"],
  received: ["canceled", "in_meeting", "meeting_not_started"],
  in_meeting: ["completed", "stopped_during_meeting"],
  completed: [],
  stopped_during_meeting: [],
  canceled: [],
  meeting_not_started: []
} as const;

export type JobAiInterviewStatus = keyof typeof allowedJobAiTransitions;

export type NullxesBusinessKey =
  | "awaiting_registration"
  | "accepted_by_ai"
  | "meeting_in_progress"
  | "canceled"
  | "stopped_mid_meeting"
  | "completed"
  | "start_error";

export interface JobAiQuestion {
  text: string;
  order: number;
}

export interface JobAiSpecialty {
  id: number;
  name: string;
  questions?: JobAiQuestion[];
}

export interface JobAiInterview {
  id: number;
  jobTitle: string;
  vacancyText: string;
  companyName: string;
  candidateFirstName: string;
  candidateLastName: string;
  zoomJoinUrl?: string;
  zoomStartUrl?: string;
  status: JobAiInterviewStatus;
  meetingAt: string;
  createdAt: string;
  statusChangedAt?: string;
  videoFilename?: string | null;
  audioFilename?: string | null;
  speechText?: string | null;
  specialty?: JobAiSpecialty;
  greetingSpeech?: string;
  finalSpeech?: string;
}

/** Ввод ФИО из прототипа UI: хранится отдельно от webhook/raw JobAI (1:1 raw не трогаем). */
export interface PrototypeCandidateIdentity {
  candidateFirstName: string;
  candidateLastName: string;
  sourceFullName: string;
  updatedAt: string;
}

export interface StoredInterview {
  jobAiId: number;
  rawPayload: JobAiInterview;
  projection: InterviewProjection;
  prototypeIdentity?: PrototypeCandidateIdentity;
}

export interface InterviewProjection {
  jobAiId: number;
  nullxesMeetingId?: string;
  sessionId?: string;
  candidateFirstName: string;
  candidateLastName: string;
  companyName: string;
  meetingAt: string;
  jobAiStatus: JobAiInterviewStatus;
  nullxesStatus: "idle" | "in_meeting" | "completed" | "stopped_during_meeting" | "failed";
  candidateEntryPath: string;
  spectatorEntryPath: string;
  nullxesBusinessKey: NullxesBusinessKey;
  nullxesBusinessLabel: string;
  updatedAt: string;
}

export interface InterviewsListResponse {
  interviews: JobAiInterview[];
  count: number;
}
