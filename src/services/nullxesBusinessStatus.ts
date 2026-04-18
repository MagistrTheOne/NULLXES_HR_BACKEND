import type { InterviewProjection, JobAiInterviewStatus, NullxesBusinessKey } from "../types/interview";

export const nullxesBusinessLabels: Record<NullxesBusinessKey, string> = {
  awaiting_registration: "Ожидает",
  accepted_by_ai: "Принята ИИ системой",
  meeting_in_progress: "Идёт встреча",
  canceled: "Встреча отменена",
  stopped_mid_meeting: "Прервано в ходе встречи",
  completed: "Завершена",
  start_error: "Не удалось начать встречу"
};

export function resolveNullxesBusiness(
  jobAiStatus: JobAiInterviewStatus,
  runtime: InterviewProjection["nullxesStatus"]
): { key: NullxesBusinessKey; label: string } {
  if (jobAiStatus === "meeting_not_started") {
    return { key: "start_error", label: nullxesBusinessLabels.start_error };
  }
  if (jobAiStatus === "canceled") {
    return { key: "canceled", label: nullxesBusinessLabels.canceled };
  }
  if (jobAiStatus === "completed") {
    return { key: "completed", label: nullxesBusinessLabels.completed };
  }
  if (jobAiStatus === "stopped_during_meeting") {
    return { key: "stopped_mid_meeting", label: nullxesBusinessLabels.stopped_mid_meeting };
  }
  if (jobAiStatus === "in_meeting" || runtime === "in_meeting") {
    return { key: "meeting_in_progress", label: nullxesBusinessLabels.meeting_in_progress };
  }
  if (jobAiStatus === "received") {
    return { key: "accepted_by_ai", label: nullxesBusinessLabels.accepted_by_ai };
  }
  if (jobAiStatus === "pending") {
    return { key: "awaiting_registration", label: nullxesBusinessLabels.awaiting_registration };
  }
  return { key: "awaiting_registration", label: nullxesBusinessLabels.awaiting_registration };
}
