export type JobAiInterviewQuestion = {
  order: number;
  text: string;
};

export type JobAiInterviewPromptContext = {
  candidateName?: string;
  companyName?: string;
  jobTitle?: string;
  vacancyText?: string;
  greetingSpeech?: string;
  finalSpeech?: string;
  questions: JobAiInterviewQuestion[];
  currentQuestionIndex: number;
};

export type JobAiInterviewPromptDiagnostics = {
  hasCandidateName: boolean;
  hasCompany: boolean;
  hasPosition: boolean;
  hasVacancy: boolean;
  hasGreeting: boolean;
  questionsCount: number;
  currentQuestionIndex: number;
};

export type JobAiInterviewPromptResult = {
  context: JobAiInterviewPromptContext;
  diagnostics: JobAiInterviewPromptDiagnostics;
  instructions: string;
  hasRequiredContext: boolean;
};

function readTrimmedString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveCandidateName(context: Record<string, unknown>): string | undefined {
  const direct = readTrimmedString(context, "candidateName");
  if (direct) return direct;
  const full = readTrimmedString(context, "candidateFullName");
  if (full) return full;
  const first = readTrimmedString(context, "candidateFirstName");
  const last = readTrimmedString(context, "candidateLastName");
  const combined = [first, last].filter(Boolean).join(" ").trim();
  return combined || undefined;
}

function resolveQuestions(context: Record<string, unknown>): JobAiInterviewQuestion[] {
  const rawQuestions = context.questions;
  if (!Array.isArray(rawQuestions)) return [];

  const parsed: JobAiInterviewQuestion[] = [];
  for (const rawQuestion of rawQuestions) {
    if (typeof rawQuestion === "string") {
      const text = rawQuestion.trim();
      if (text) parsed.push({ order: parsed.length + 1, text });
      continue;
    }
    if (!rawQuestion || typeof rawQuestion !== "object") continue;
    const record = rawQuestion as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) continue;
    const order = typeof record.order === "number" && Number.isFinite(record.order) ? record.order : parsed.length + 1;
    parsed.push({ order, text });
    if (parsed.length >= 30) break;
  }

  return parsed.sort((a, b) => a.order - b.order).slice(0, 20);
}

export function buildJobAiInterviewPromptFromMetadata(
  metadata: Record<string, unknown> | undefined,
  currentQuestionIndex = 0
): JobAiInterviewPromptResult {
  const interviewContext = (metadata?.interviewContext ?? {}) as Record<string, unknown>;
  const context: JobAiInterviewPromptContext = {
    candidateName: resolveCandidateName(interviewContext),
    companyName: readTrimmedString(interviewContext, "companyName"),
    jobTitle: readTrimmedString(interviewContext, "jobTitle"),
    vacancyText: readTrimmedString(interviewContext, "vacancyText"),
    greetingSpeech: readTrimmedString(interviewContext, "greetingSpeech"),
    finalSpeech: readTrimmedString(interviewContext, "finalSpeech"),
    questions: resolveQuestions(interviewContext),
    currentQuestionIndex
  };

  const diagnostics: JobAiInterviewPromptDiagnostics = {
    hasCandidateName: Boolean(context.candidateName),
    hasCompany: Boolean(context.companyName),
    hasPosition: Boolean(context.jobTitle),
    hasVacancy: Boolean(context.vacancyText),
    hasGreeting: Boolean(context.greetingSpeech),
    questionsCount: context.questions.length,
    currentQuestionIndex: context.currentQuestionIndex
  };

  const greeting =
    context.greetingSpeech ??
    [
      context.candidateName ? `Здравствуйте, ${context.candidateName}.` : "Здравствуйте.",
      context.jobTitle ? `Это интервью на позицию ${context.jobTitle}.` : null,
      context.companyName ? `Компания: ${context.companyName}.` : null,
      "Вы готовы пройти интервью?"
    ]
      .filter(Boolean)
      .join(" ");
  const questionsBlock = context.questions
    .map((question, index) => `${index + 1}. [order=${question.order}] ${question.text}`)
    .join("\n");

  const instructions = [
    "# Роль",
    "Ты — HR-интервьюер JobAI. Ты НЕ общий ассистент, НЕ саппорт и НЕ чат-бот для свободной помощи.",
    "Никогда не говори и не спрашивай: «чем могу помочь», «как могу помочь», «как я могу вам помочь», «что вас интересует».",
    "Ты уже находишься внутри активного интервью. Твоя задача — провести собеседование по заранее заданному JobAI-сценарию.",
    "",
    "# Язык",
    "Всегда говори на русском языке. Не переходи на английский или китайский без явной просьбы кандидата.",
    "",
    "# Правила интервью",
    "- Используй только список вопросов ниже. Не придумывай новые вопросы.",
    "- Задавай один вопрос за раз.",
    "- Не объявляй номера вопросов вслух («вопрос X из Y» запрещено).",
    `- Текущий индекс вопроса: ${context.currentQuestionIndex}. Начни с вопроса по этому индексу, если система не сказала иначе.`,
    "- Если кандидат отвечает — коротко поблагодари и переходи к следующему вопросу по списку.",
    "- Если контекста вакансии недостаточно — не додумывай факты, а опирайся только на переданные данные.",
    "",
    "# Контекст JobAI",
    context.candidateName ? `Кандидат: ${context.candidateName}` : "Кандидат: имя не передано",
    context.companyName ? `Компания: ${context.companyName}` : "Компания: не передана",
    context.jobTitle ? `Позиция: ${context.jobTitle}` : "Позиция: не передана",
    context.vacancyText ? `Описание вакансии:\n${context.vacancyText}` : "Описание вакансии: не передано",
    "",
    "# Приветствие JobAI",
    "Произнеси приветствие ниже как официальный старт интервью. Не заменяй его generic-фразой.",
    greeting,
    "",
    "# Вопросы JobAI (строго по order)",
    questionsBlock || "Вопросы не переданы.",
    "",
    context.finalSpeech ? `# Финальная фраза JobAI\n${context.finalSpeech}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  return {
    context,
    diagnostics,
    instructions,
    hasRequiredContext: context.questions.length > 0
  };
}
