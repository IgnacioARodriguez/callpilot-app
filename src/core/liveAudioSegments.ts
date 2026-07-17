export const appendSegmentChunk = <T>(
  chunksById: Map<string, T[]>,
  channelId: string,
  chunk: T,
): void => {
  const chunks = chunksById.get(channelId) ?? [];
  chunks.push(chunk);
  chunksById.set(channelId, chunks);
};

export const consumeSegmentChunks = <T>(
  chunksById: Map<string, T[]>,
  channelId: string,
): T[] => {
  const chunks = chunksById.get(channelId) ?? [];
  chunksById.delete(channelId);
  return chunks;
};

export const shouldDrainTranscriptionQueue = (
  liveContinue: boolean,
  queuedCount: number,
): boolean => liveContinue || queuedCount > 0;

export const shouldSendNativelyFrame = (
  speaker: "candidate" | "interviewer",
  energy: { rms: number; peak: number },
  threshold = { rms: 0.0018, peak: 0.018 },
): boolean => {
  if (speaker === "interviewer") return true;
  return energy.rms >= threshold.rms || energy.peak >= threshold.peak;
};
