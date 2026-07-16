# CallPilot V0

Private desktop interview copilot built as a new app in this directory. The original repository under `../original-repo` is intentionally not modified.

## Run

```powershell
npm install
npm run desktop:dev
```

For a production-style local run:

```powershell
npm run desktop:start
```

For the unpacked Windows app:

```powershell
npm run pack
.\release\CallPilot-win32-x64\CallPilot.exe
```

## OpenAI Setup

Set `OPENAI_API_KEY` before launching desktop mode, paste a session key in the app, or save an encrypted local key from the OpenAI settings panel.

Desktop OpenAI features currently include:

- Responses generation through `/v1/responses`.
- Screenshot analysis through Responses image input.
- Push-to-talk microphone transcription through `/v1/audio/transcriptions`.
- Local OCR through Tesseract.js for screen text extraction without sending images to a cloud provider.

The default transcription model is `gpt-4o-transcribe`. Mic recordings are sent from Electron main as `multipart/form-data`; API keys are not stored in browser localStorage.

## Ollama Setup

CallPilot can generate answers locally through Ollama.

```powershell
ollama serve
ollama pull llama3.1
```

Then select `Provider: Ollama`, use `Model: llama3.1`, and keep `Ollama URL` as `http://localhost:11434` unless Ollama is running elsewhere.

## Local OCR

Use the `OCR` button in `Screen Context` to capture the screen and extract visible text locally with Tesseract.js. The first run may initialize OCR language data; extracted text is placed directly into the screen context for prompt grounding.

## Verification

```powershell
npm test
npm run test:e2e:subset
npm run test:e2e:full
npm run build
npm run verify:desktop
npm run pack
npm run verify:package
```

`npm run test:protected-assets` fails if `tests/fixtures`, `tests/rubrics`, or `tests/baselines` changed without an explicit human approval. For an approved fixture/rubric/baseline update, run it with `ALLOW_PROTECTED_TEST_ASSET_CHANGES=1`.

`npm run verify:isolation` checks that the original repo has not received generated app artifacts such as `src/core`, `node_modules`, or `dist`.

Privacy-specific checks:

```powershell
npm run test:privacy
npm run verify:privacy
```

Manual platform QA for consented calls is documented in `tests/privacy/platform-privacy-qa.md`, with the supported matrix in `tests/privacy/platform-privacy-matrix.json`. These checks cover ordinary video-call sharing with an authorized observer; proctoring, anti-detection, and bypass scenarios are out of scope.

Privacy controls include:

- `Share Safe`: enables approved-call privacy posture, hides the window, enables best-effort capture protection, and enables passthrough.
- `Check`: runs a local privacy posture check and reports `safe`, `risk`, or `unknown`.
- `Reset`: immediately returns to visible, interactive, not-approved defaults. Desktop shortcut: `Ctrl Alt R`.
