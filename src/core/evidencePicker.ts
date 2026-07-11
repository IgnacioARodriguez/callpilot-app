import type { GlobalContext } from "./context.ts";

export type EvidenceSource = "resume" | "star_stories" | "job_description" | "notes" | "screen_context" | "transcript";

export interface EvidenceItem {
  source: EvidenceSource;
  label: string;
  text: string;
  score: number;
  matchedTerms: string[];
}

export interface EvidenceSelection {
  items: EvidenceItem[];
  debug: {
    queryTerms: string[];
    candidateCount: number;
    selectedCount: number;
    strategy?: "lexical" | "embedding" | "embedding_fallback";
  };
}

export type EvidenceCandidate = Omit<EvidenceItem, "score" | "matchedTerms">;

export interface EvidenceEmbedding {
  text: string;
  vector: number[];
}

export type EvidenceEmbedder = (texts: string[]) => Promise<EvidenceEmbedding[]>;

const stopWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "because", "but", "by", "can", "did", "do", "does", "for", "from",
  "have", "how", "i", "in", "instead", "is", "it", "me", "my", "not", "of", "on", "or", "our", "rather", "should",
  "so", "than", "that", "the", "their", "this", "to", "use", "used", "using", "was", "we", "were", "what", "when",
  "where", "why", "with", "you",
]);

const aliases: Record<string, string[]> = {
  sql: ["postgres", "postgresql", "mysql", "relational", "joins", "join", "transaction", "transactions", "acid", "consistency", "auditability", "reconciliation"],
  nosql: ["mongo", "mongodb", "dynamodb", "document", "documents", "key-value", "eventual", "schema-less"],
  payments: ["payment", "settlement", "reconciliation", "ledger", "financial", "finance", "fx", "banking"],
  scale: ["scaling", "latency", "throughput", "distributed", "load", "performance"],
  leadership: ["lead", "led", "stakeholder", "mentor", "conflict", "ownership", "initiative"],
};

const tokenize = (text: string): string[] => {
  const raw = text.toLowerCase().match(/[a-z0-9+#.-]{2,}/g) ?? [];
  const expanded = new Set<string>();
  for (const token of raw) {
    const normalized = token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
    if (!normalized || stopWords.has(normalized)) continue;
    expanded.add(normalized);
    for (const [term, related] of Object.entries(aliases)) {
      if (term === normalized || related.includes(normalized)) {
        expanded.add(term);
        related.forEach((alias) => expanded.add(alias));
      }
    }
  }
  return [...expanded];
};

const splitEvidence = (text: string): string[] => {
  const clean = text.trim();
  if (!clean) return [];
  const paragraphs = clean
    .split(/\n{2,}|(?:^|\n)\s*(?:STAR|Situation|Task|Action|Result|Project|Experience|Role)\s*:/i)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length >= 24);
  if (paragraphs.length > 0) return paragraphs.map((part) => part.slice(0, 900));
  return clean.match(/.{1,700}(?:\s+|$)/g)?.map((part) => part.trim()).filter(Boolean) ?? [];
};

const sourceWeight: Record<EvidenceSource, number> = {
  star_stories: 1.35,
  resume: 1.15,
  job_description: 1.05,
  notes: 1,
  screen_context: 0.9,
  transcript: 0.85,
};

export const buildEvidenceCandidates = (context: GlobalContext): EvidenceCandidate[] => {
  const sources: Array<{ source: EvidenceSource; label: string; text: string }> = [
    { source: "star_stories", label: "STAR story", text: context.starStories },
    { source: "resume", label: "CV", text: context.resumeText },
    { source: "job_description", label: "Job description", text: context.jobDescription },
    { source: "notes", label: "Extra notes", text: context.userNotes },
    { source: "screen_context", label: "Screen context", text: context.screenContext.visibleText },
  ];
  return sources.flatMap(({ source, label, text }) =>
    splitEvidence(text).map((chunk, index) => ({ source, label: `${label} ${index + 1}`, text: chunk })),
  );
};

export const pickEvidence = (context: GlobalContext, query: string, maxItems = 4): EvidenceSelection => {
  const queryTerms = tokenize([
    query,
    context.companyName,
    context.roleTitle,
    context.targetUseCase,
    context.screenContext.summary,
  ].join(" "));
  const candidates = buildEvidenceCandidates(context);
  const scored = candidates
    .map((candidate): EvidenceItem => {
      const candidateTerms = new Set(tokenize(candidate.text));
      const matchedTerms = queryTerms.filter((term) => candidateTerms.has(term));
      const phraseBoost = queryTerms.some((term) => candidate.text.toLowerCase().includes(term)) ? 0.5 : 0;
      const score = (matchedTerms.length + phraseBoost) * sourceWeight[candidate.source];
      return { ...candidate, score: Number(score.toFixed(3)), matchedTerms: matchedTerms.slice(0, 12) };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, maxItems);

  return {
    items: scored,
    debug: {
      queryTerms: queryTerms.slice(0, 40),
      candidateCount: candidates.length,
      selectedCount: scored.length,
      strategy: "lexical",
    },
  };
};

const cosineSimilarity = (left: number[], right: number[]): number => {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
};

export const pickEvidenceWithEmbeddings = async (
  context: GlobalContext,
  query: string,
  embedder: EvidenceEmbedder,
  maxItems = 4,
): Promise<EvidenceSelection> => {
  const candidates = buildEvidenceCandidates(context);
  if (candidates.length === 0) {
    return {
      items: [],
      debug: {
        queryTerms: [],
        candidateCount: 0,
        selectedCount: 0,
        strategy: "embedding",
      },
    };
  }

  try {
    const queryText = [
      query,
      context.companyName,
      context.roleTitle,
      context.targetUseCase,
      context.screenContext.summary,
    ].join(" ");
    const [queryEmbedding, ...candidateEmbeddings] = await embedder([
      queryText,
      ...candidates.map((candidate) => candidate.text),
    ]);
    const queryVector = queryEmbedding?.vector ?? [];
    const lexicalTerms = tokenize(queryText).slice(0, 40);
    const scored = candidates
      .map((candidate, index): EvidenceItem => {
        const vector = candidateEmbeddings[index]?.vector ?? [];
        const semanticScore = Math.max(0, cosineSimilarity(queryVector, vector));
        const candidateTerms = new Set(tokenize(candidate.text));
        const matchedTerms = lexicalTerms.filter((term) => candidateTerms.has(term));
        const score = (semanticScore * 10 + matchedTerms.length * 0.15) * sourceWeight[candidate.source];
        return { ...candidate, score: Number(score.toFixed(3)), matchedTerms: matchedTerms.slice(0, 12) };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
      .slice(0, maxItems);

    return {
      items: scored,
      debug: {
        queryTerms: lexicalTerms,
        candidateCount: candidates.length,
        selectedCount: scored.length,
        strategy: "embedding",
      },
    };
  } catch {
    const fallback = pickEvidence(context, query, maxItems);
    return {
      ...fallback,
      debug: {
        ...fallback.debug,
        strategy: "embedding_fallback",
      },
    };
  }
};

export const formatEvidenceForPrompt = (selection: EvidenceSelection): string =>
  selection.items
    .map((item, index) => [
      `[${index + 1}] ${item.label} (${item.source}, score ${item.score})`,
      item.text,
      item.matchedTerms.length > 0 ? `Matched terms: ${item.matchedTerms.join(", ")}` : "",
    ].filter(Boolean).join("\n"))
    .join("\n\n");
