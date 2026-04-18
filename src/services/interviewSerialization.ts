import type { StoredInterview } from "../types/interview";
import { applyInterviewTemplates } from "./templateInterpolation";

/** Подстановки: имя из проекции (учёт прототипного ФИО), вакансия/компания из сырого JobAI. */
function templateVars(entry: StoredInterview) {
  return {
    job_title: entry.rawPayload.jobTitle ?? "",
    first_name: entry.projection.candidateFirstName ?? entry.rawPayload.candidateFirstName ?? "",
    company_name: entry.rawPayload.companyName ?? ""
  };
}

export function serializeInterviewListItem(entry: StoredInterview): Record<string, unknown> {
  const vars = templateVars(entry);
  return {
    ...entry.projection,
    statusChangedAt: entry.rawPayload.statusChangedAt,
    createdAt: entry.rawPayload.createdAt,
    greetingSpeechResolved: applyInterviewTemplates(entry.rawPayload.greetingSpeech, vars),
    finalSpeechResolved: applyInterviewTemplates(entry.rawPayload.finalSpeech, vars)
  };
}

export function serializeInterviewDetail(entry: StoredInterview): {
  interview: Record<string, unknown>;
  projection: StoredInterview["projection"];
  prototypeCandidate: StoredInterview["prototypeIdentity"] | null;
} {
  const vars = templateVars(entry);
  return {
    interview: {
      ...entry.rawPayload,
      greetingSpeechResolved: applyInterviewTemplates(entry.rawPayload.greetingSpeech, vars),
      finalSpeechResolved: applyInterviewTemplates(entry.rawPayload.finalSpeech, vars)
    },
    projection: entry.projection,
    prototypeCandidate: entry.prototypeIdentity ?? null
  };
}
