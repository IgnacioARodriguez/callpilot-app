# multi_surface_memory_p0

P0 live-coding replay fixture for multi-surface visual context.

The goal is to verify that CallPilot can use screenshots from different visual
surfaces without hardcoding a platform, language, or file name convention.

## Surfaces

- `instructions`: requirements or README content.
- `implementation`: code that should be modified.
- `tests`: executable checks or behavioral examples.
- `terminal`: output, failure, or passing run evidence.
- `file_tree`: project navigation or file relationship evidence.

## Capture Rule

Do not generate synthetic PNGs. Reproduce each stage in a live editor or
CoderPad-like environment and capture the listed surfaces. If the platform is
not CoderPad, keep the same semantic role in the filename and manifest.

## Coverage

This fixture targets the P0 risks from the visual/conversational taxonomy:

- B2: implementation and tests in distinct surfaces.
- B3: instructions separate from code.
- B5: terminal output with code seen earlier.
- C1: terminal error mapped to a fix.
- E1: tests added during the interview.
- G2: avoid inventing unseen visual content.
- MEM, PER, RAZ, SYNC: memory, perception, reasoning, synchronization.
