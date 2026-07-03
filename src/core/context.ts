import { createEmptyScreenContext, type ScreenContext } from "./screenContext.ts";
import { createEmptyTranscriptSnapshot, type TranscriptSnapshot } from "./transcriptBuffer.ts";
import type { AssistantModeId } from "./modes.ts";

export type PreferredLanguage = "english" | "spanish" | "auto";

export interface GlobalContext {
  companyName: string;
  roleTitle: string;
  resumeText: string;
  starStories: string;
  jobDescription: string;
  userProfile: string;
  targetUseCase: string;
  interviewType: string;
  preferredLanguage: PreferredLanguage;
  preferredAnswerFormat: string;
  activeMode: AssistantModeId;
  transcript: TranscriptSnapshot;
  screenContext: ScreenContext;
  userNotes: string;
  codingLanguagePreference: string;
  responseConstraints: string[];
  updatedAt: string;
}

export const createGlobalContext = (input: Partial<GlobalContext> = {}): GlobalContext => ({
  companyName: input.companyName ?? "",
  roleTitle: input.roleTitle ?? "",
  resumeText: input.resumeText ?? "",
  starStories: input.starStories ?? "",
  jobDescription: input.jobDescription ?? "",
  userProfile: input.userProfile ?? "",
  targetUseCase: input.targetUseCase ?? "technical interview preparation",
  interviewType: input.interviewType ?? "",
  preferredLanguage: input.preferredLanguage ?? "auto",
  preferredAnswerFormat: input.preferredAnswerFormat ?? "interview-ready bullets",
  activeMode: input.activeMode ?? "live_coding",
  transcript: input.transcript ?? createEmptyTranscriptSnapshot(),
  screenContext: input.screenContext ?? createEmptyScreenContext(),
  userNotes: input.userNotes ?? "",
  codingLanguagePreference: input.codingLanguagePreference ?? "Python",
  responseConstraints: input.responseConstraints ?? ["Be concise", "Separate facts from assumptions"],
  updatedAt: input.updatedAt ?? new Date().toISOString(),
});
