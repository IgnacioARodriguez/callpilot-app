# Mutations

Reserved for deterministic mutation definitions. Mutations must not read
expected answers when constructing inputs.

`datasetMutations.cjs` currently supports development-only JSONL case mutations
for OCR confusions, browser chrome noise, partial statement crops, and transcript
fillers. These mutate `input` fields only and preserve expectations.

Generate mutations with:

```powershell
node scripts/generate-eval-mutations.mjs --input=path\to\development\dataset.jsonl --out=path\to\dataset.mutated.jsonl
```
