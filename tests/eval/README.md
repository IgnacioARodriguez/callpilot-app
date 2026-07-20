# CallPilot Evaluation Datasets

Evaluation splits are enforced by `tests/eval/datasetPolicy.cjs`.

## Splits

- `development`: known material used while improving CallPilot. Existing local MP4s, generated manifests in `.cache`, and repository fixtures belong here.
- `validation`: external sessions used to measure changes during development. Do not tune prompts, regexes, repairs, or fixtures to their literal content.
- `holdout`: external sessions reserved for release decisions. Do not inspect raw recordings, transcripts, screenshots, expected answers, or executable tests while implementing fixes.

Splits are by complete interview/session, never by checkpoint.

## External MP4 Ingestion

Put validation or holdout media in a directory outside this repository, then run:

```powershell
$env:CALLPILOT_EVAL_VALIDATION_DIR="D:\callpilot-eval\validation"
node tests/local-video-analysis/analyzeLocalVideo.cjs --split=validation --dataset=backend-interviews-v1 --source-id=interview-001 --video="D:\callpilot-eval\validation\interview-001\interview.mp4"
```

For holdout:

```powershell
$env:CALLPILOT_EVAL_HOLDOUT_DIR="D:\callpilot-eval\holdout"
node tests/local-video-analysis/analyzeLocalVideo.cjs --split=holdout --dataset=backend-holdout-v1 --source-id=interview-101 --video="D:\callpilot-eval\holdout\interview-101\interview.mp4"
```

Then run the manifest explicitly:

```powershell
npm run build
node tests/e2e/video-interview/localVideoInterviewRunner.cjs --split=validation --dataset-dir="D:\callpilot-eval\validation" --manifest="D:\callpilot-eval\validation\interview-001\<analysis-run>\manifest.json"
```

The existing MP4/manifests generated during earlier iterations are always development fixtures. They must not be used as validation or holdout evidence.
