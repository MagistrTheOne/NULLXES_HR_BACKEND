export type InterviewTemplateVars = {
  job_title: string;
  first_name: string;
  company_name: string;
};

export function applyInterviewTemplates(text: string | undefined, vars: InterviewTemplateVars): string | undefined {
  if (typeof text !== "string" || text.length === 0) {
    return text;
  }
  return text
    .replaceAll("{{job_title}}", vars.job_title)
    .replaceAll("{{first_name}}", vars.first_name)
    .replaceAll("{{company_name}}", vars.company_name);
}
