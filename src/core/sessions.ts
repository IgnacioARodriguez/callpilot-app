import type { PreferredLanguage } from "./context.ts";
import type { AssistantModeId } from "./modes.ts";
import type { ModelProvider } from "./modelClient.ts";
import type { TranscriptSnapshot } from "./transcriptBuffer.ts";
import { parseCodingAnswerPayload, type CodingAnswerPayload } from "./answerPayload.ts";

export interface SavedSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  activeMode: AssistantModeId;
  transcript: TranscriptSnapshot;
  screenText: string;
  companyName: string;
  roleTitle: string;
  resumeText: string;
  starStories: string;
  jobDescription: string;
  notes: string;
  profile: string;
  targetUseCase: string;
  preferredLanguage: PreferredLanguage;
  codingLanguage: string;
  answerVerbosity: "short" | "medium" | "detailed";
  modelProvider: ModelProvider;
  modelName: string;
  question: string;
  answer: string;
  codingPayload: CodingAnswerPayload | null;
}

type OptionalSessionFields = "companyName" | "roleTitle" | "resumeText" | "starStories" | "jobDescription" | "codingPayload";

export type SessionDraft = Omit<SavedSession, "id" | "title" | "createdAt" | "updatedAt" | OptionalSessionFields> &
  Partial<Pick<SavedSession, OptionalSessionFields>> & {
  id?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
};

export const CURRENT_SESSION_KEY = "callpilot_v0_session";
export const SESSION_LIBRARY_KEY = "callpilot_v0_session_library";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const makeSessionTitle = (session: Pick<SavedSession, "activeMode" | "question" | "screenText" | "updatedAt">): string => {
  const source = session.question.trim() || session.screenText.trim() || session.activeMode.replaceAll("_", " ");
  const firstLine = source.split(/\r?\n/)[0]?.trim() || "Untitled session";
  return firstLine.slice(0, 80);
};

export const createSessionSnapshot = (draft: SessionDraft, now = new Date()): SavedSession => {
  const timestamp = now.toISOString();
  const base = {
    ...draft,
    id: draft.id ?? `session-${now.getTime()}`,
    createdAt: draft.createdAt ?? timestamp,
    updatedAt: draft.updatedAt ?? timestamp,
  };

  return {
    ...base,
    companyName: draft.companyName ?? "",
    roleTitle: draft.roleTitle ?? "",
    resumeText: draft.resumeText ?? "",
    starStories: draft.starStories ?? "",
    jobDescription: draft.jobDescription ?? "",
    codingPayload: draft.codingPayload ?? null,
    title: draft.title?.trim() || makeSessionTitle(base),
  };
};

export const sanitizeSessionImport = (value: unknown): SavedSession | null => {
  if (!isRecord(value)) return null;
  const transcript = isRecord(value.transcript) && Array.isArray(value.transcript.messages)
    ? value.transcript as unknown as TranscriptSnapshot
    : null;
  if (!transcript) return null;

  const activeMode = value.activeMode;
  if (!["live_coding", "system_design", "behavioral", "technical_qa", "meeting_notes"].includes(String(activeMode))) {
    return null;
  }

  return createSessionSnapshot({
    id: typeof value.id === "string" ? value.id : undefined,
    title: typeof value.title === "string" ? value.title : undefined,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : undefined,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
    activeMode: activeMode as AssistantModeId,
    transcript,
    screenText: typeof value.screenText === "string" ? value.screenText : "",
    companyName: typeof value.companyName === "string" ? value.companyName : "",
    roleTitle: typeof value.roleTitle === "string" ? value.roleTitle : "",
    resumeText: typeof value.resumeText === "string" ? value.resumeText : "",
    starStories: typeof value.starStories === "string" ? value.starStories : "",
    jobDescription: typeof value.jobDescription === "string" ? value.jobDescription : "",
    notes: typeof value.notes === "string" ? value.notes : "",
    profile: typeof value.profile === "string" ? value.profile : "",
    targetUseCase: typeof value.targetUseCase === "string" ? value.targetUseCase : "technical interview preparation",
    preferredLanguage: ["english", "spanish", "auto"].includes(String(value.preferredLanguage))
      ? value.preferredLanguage as PreferredLanguage
      : "auto",
    codingLanguage: typeof value.codingLanguage === "string" ? value.codingLanguage : "Python",
    answerVerbosity: ["short", "medium", "detailed"].includes(String(value.answerVerbosity))
      ? value.answerVerbosity as "short" | "medium" | "detailed"
      : "medium",
    modelProvider: value.modelProvider === "openai" || value.modelProvider === "ollama" || value.modelProvider === "natively" || value.modelProvider === "nvidia" || value.modelProvider === "groq" ? value.modelProvider : "mock",
    modelName: typeof value.modelName === "string" ? value.modelName : "",
    question: typeof value.question === "string" ? value.question : "",
    answer: typeof value.answer === "string" ? value.answer : "",
    codingPayload: parseCodingAnswerPayload(value.codingPayload, { allowEmpty: true }),
  });
};

export const serializeSession = (session: SavedSession): string => JSON.stringify(session, null, 2);

export const parseSessionJson = (json: string): SavedSession | null => {
  try {
    return sanitizeSessionImport(JSON.parse(json));
  } catch {
    return null;
  }
};

export const upsertSession = (library: SavedSession[], session: SavedSession): SavedSession[] => {
  const next = library.filter((item) => item.id !== session.id);
  return [session, ...next].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
};
