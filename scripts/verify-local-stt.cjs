const path = require("node:path");
const { env, pipeline } = require("@huggingface/transformers");

const main = async () => {
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = false;
  env.useFSCache = true;
  env.cacheDir = path.join(process.cwd(), ".cache", "transformers");

  const recognizer = await pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny", {
    dtype: "q8",
  });

  const audio = new Float32Array(16000);
  const result = await recognizer(audio, {
    chunk_length_s: 10,
    task: "transcribe",
  });

  if (!result || typeof result.text !== "string") {
    throw new Error("Local STT returned an invalid result.");
  }

  console.log("Local STT verified.");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
