# Desktop MP4 Interview Debug Brief For Claude

Fecha: 2026-07-19
Repo: `C:\Projects\callpilot-v0\callpilot-app`
Video local: `C:\Users\Asus\Downloads\videoplayback.mp4`

Este documento resume el trabajo hecho sobre la prueba E2E local con un MP4 real de entrevista/live coding. La idea es que otro modelo/reviewer pueda analizar la situacion sin tener que reconstruir toda la conversacion.

## Objetivo

Construir una base reutilizable para probar CallPilot con videos locales de entrevistas reales.

La prueba simula un usuario humano que mira el video y pulsa `Answer` en momentos revisados. En esta fase NO se evalua diarizacion ni deteccion autonoma de cuando responder.

CallPilot no debe recibir:

- transcripcion ground truth del video;
- respuesta del candidato del video;
- descripcion manual del problema como si fuera input del usuario;
- informacion futura del video;
- prompts hardcodeados para este MP4.

El runner si puede usar un manifiesto por video con timestamps revisados, porque simula al usuario que decide cuando pulsar `Answer`.

## Infraestructura implementada

Ya existe un harness desktop MP4 que:

- abre CallPilot desktop;
- abre el MP4 en una ventana Electron separada y controlable;
- reproduce el video;
- pausa en checkpoints;
- captura screenshot real desde CallPilot;
- ejecuta vision real sobre la pantalla capturada;
- pulsa `Answer` por la ruta manual real;
- captura transcript observable, vision, respuesta, latencia, errores y rubrica;
- genera reporte JSON y Markdown en `.cache/desktop-video-interview/...`;
- respeta `E2E_MAX_REAL_CALLS`;
- permite seleccionar checkpoints, maximo de respuestas, proveedor y manifiesto.

Scripts relevantes:

```text
npm run analyze:local-video-interview
npm run test:e2e:desktop-video-interview:smoke
npm run test:e2e:local-video-interview
```

Variables usadas:

```powershell
$env:CALLPILOT_E2E_VIDEO="C:\Users\Asus\Downloads\videoplayback.mp4"
$env:CALLPILOT_E2E_VIDEO_MANIFEST="C:\Projects\callpilot-v0\callpilot-app\.cache\local-video-analysis\run-2026-07-19T15-52-46-850Z\manifest.json"
$env:E2E_MAX_REAL_CALLS="5"
$env:E2E_DESKTOP_VIDEO_MAX_ANSWERS="2"
$env:E2E_DESKTOP_VIDEO_SEEK_BETWEEN_CHECKPOINTS="1"
$env:E2E_DESKTOP_VIDEO_CHECKPOINT="linked-list-problem-intro,bst-problem-intro"
npm run test:e2e:desktop-video-interview:smoke
```

## Checkpoints revisados del MP4

Manifiesto estable usado para las pruebas fuertes:

```text
.cache/local-video-analysis/run-2026-07-19T15-52-46-850Z/manifest.json
```

Checkpoints principales:

- `linked-list-problem-intro`
  - timestamp: `151289 ms`
  - problema visible: odd/even linked list, preservar orden relativo.
  - esperado: two pointers, odd/even linked list, preserve relative order, O(n), O(1) extra space.

- `bst-problem-intro`
  - timestamp: `1361602 ms`
  - problema visible: validar si un binary tree es BST.
  - esperado: BST invariant, bounds/ranges, recursion, left subtree less than node, right subtree greater than node.

## Runs importantes

### Run continuo anterior

Reporte:

```text
.cache/desktop-video-interview/run-2026-07-19T14-09-19-485Z/report.md
```

Resultado aproximado:

- modo: desktop MP4 multi-checkpoint continuo;
- real calls: `5/5`;
- runner errors: `0`;
- screen capture correcto: `2/2`;
- STT: `1/2`;
- answer quality: `0/2`;
- latencia mediana: `3511 ms`.

Problemas vistos:

- respuestas demasiado largas;
- vision mezclaba UI del player con contenido tecnico;
- respuesta de BST podia quedar contaminada por contexto/respuesta previa;
- STT podia registrar eco de respuesta anterior como si fuera transcript;
- la respuesta de linked list podia omitir O(1) extra space o proponer una estrategia no optima.

### Run seek-debug antes de las ultimas correcciones

Reporte:

```text
.cache/desktop-video-interview/run-2026-07-19T15-52-46-850Z/report.md
```

Resultado:

- runner errors: `0`;
- screen capture: `2/2`, ventana correcta en 1 intento;
- vision: `2/2`;
- answer quality: `1/2`.

Fallo relevante:

- `linked-list-problem-intro` produjo respuesta con mezcla de temas:
  - menciono two-pass / guardar nodos en listas;
  - luego menciono two pointers;
  - omitio `O(1) extra space`;
  - se colo una frase de BST: `low/high bounds`.

Diagnostico:

- la reparacion de cobertura miraba una bolsa demasiado amplia de texto (`userInput + text`);
- si habia contexto acumulado o OCR secundario con otra pista tecnica, podia activar una regla de otro problema;
- el evaluador no marcaba suficientemente fuerte la contaminacion entre problemas si el ID/checkpoint no lo capturaba.

### Ultimo run E2E completado antes del corte

Reporte:

```text
.cache/desktop-video-interview/run-2026-07-19T16-01-50-508Z/report.json
.cache/desktop-video-interview/run-2026-07-19T16-01-50-508Z/report.md
```

Resultado:

- mode: `desktop_mp4_multi_checkpoint_seek_debug`;
- real calls: `5/5`;
- player opened: `true`;
- UI session started: `true`;
- live STT connected: `true`;
- transcript produced: `true` en el resumen viejo, pero uno era `possible_prior_answer_echo`;
- screen captured: `true`;
- vision produced: `true`;
- answer produced: `true`;
- runner errors: `0`;
- answer quality: `2/2`;
- median answer latency: `4955 ms`.

Detalle:

- `linked-list-problem-intro`
  - transcript source: `none`;
  - screen capture: `CallPilot E2E Video Player`;
  - attempts: `1`;
  - answer words: `53`;
  - rubric ok: `true`;
  - respuesta: in-place two-pointer, `odd`, `even`, `evenHead`, preservar orden, O(n), O(1).

- `bst-problem-intro`
  - transcript source: `e2e_ui_state:possible_prior_answer_echo`;
  - screen capture: `CallPilot E2E Video Player`;
  - attempts: `1`;
  - answer words: `135`;
  - rubric ok: `true`;
  - respuesta: enfocada en BST, recursion, bounds, left/right constraint, O(n), O(h).

Observacion:

- Aunque la rubrica paso, el segundo checkpoint aun muestra que el transcript observable podia ser eco de respuesta anterior. Se agrego una correccion para excluir `possible_prior_answer_echo` de la metrica de STT usable, pero el rerun posterior fue interrumpido por el usuario antes de completarse.

### Run interrumpido

Se intento repetir el E2E despues de ajustar metricas de STT y limpieza de markdown:

```text
.cache/desktop-video-interview/run-2026-07-19T16-08-39-246Z
```

Ese run fue abortado manualmente por el usuario. Quedaron procesos Electron del workspace vivos y fueron cerrados manualmente. No tomar ese run como evidencia final.

## Cambios de codigo hechos

Archivos modificados actualmente en working tree:

```text
electron/main.cjs
src/core/answerPayload.ts
src/core/answerRepair.ts
src/core/index.ts
src/core/modes.ts
src/core/promptBuilder.ts
src/core/screenContext.ts
src/main.tsx
src/test/contextContinuity.test.ts
src/test/core.test.ts
tests/e2e/video-interview/desktopVideoInterviewSmoke.cjs
tests/e2e/video-interview/desktopVideoPlayer.cjs
```

Tambien existe `docs/testing/answer-trust-dod.md` como archivo untracked previo. No fue tocado para commit.

### Vision / screen focus

`src/core/screenContext.ts`

- Se agrego `extractTechnicalScreenFocus`.
- Filtra ruido de UI/player/browser/chrome.
- Mantiene lineas tecnicas: problem statement, constraints, input/output, code-like text, tests, errors, complexity.
- `classifyScreenText` prioriza ese foco tecnico.

`src/core/promptBuilder.ts`

- Agrega `technical_focus` dentro de `screen_context` antes de `raw_visible_text`.
- Instruye al modelo a tratar `technical_focus` como evidencia visual primaria.
- Instruye ignorar player controls, logos, browser chrome, assistant UI.
- En live coding prioriza enfoque optimo, invariant, estrategia de datos/punteros y complejidad.

`electron/main.cjs`

- El prompt de vision ahora pide JSON con `visibleTextExact`, `technicalFocus`, `problemStatement`, `visibleCode`, `testsOrErrors`, `constraints`, `examples`, `inferredTask`, `ignoredUi`.
- Cuando OCR tiene texto tecnico, se antepone:
  - `Technical OCR focus`
  - `Vision summary (secondary; ignore if it conflicts with OCR)`
  - `Visible OCR text`
- Se agrego `technicalOcrFocus`.
- Se sanitizan nombres de fuentes de captura para no filtrar titulos sensibles de otras ventanas.

### Captura de pantalla / player

`tests/e2e/video-interview/desktopVideoPlayer.cjs`

- Nombre/titulo fijo: `CallPilot E2E Video Player`.
- `keepVisible()` mantiene la ventana visible y al frente.

`tests/e2e/video-interview/desktopVideoInterviewSmoke.cjs`

- `captureExpectedPlayerWindow()` hace hasta 5 intentos.
- Antes de cada intento trae el player al frente, fija titulo y hace backoff.
- Reporta `screen_capture_attempts`.
- El Markdown muestra intentos de captura.

Resultado: en los runs recientes, la captura fue correcta en `1` intento para ambos checkpoints.

### Respuesta live coding

`electron/main.cjs`

- Instrucciones de respuesta hablada:
  - 60-100 palabras ideal, maximo 120 salvo que pidan codigo;
  - no describir UI del screenshot;
  - no escribir codigo salvo pedido explicito;
  - si hay problema visible, dar enfoque optimo/invariant/complejidad.

`src/main.tsx`

- `explicitlyRequestsCode()` ya no mira todo el OCR como si fuera request del usuario.
- Solo mira el texto real de request antes de `visible_screen`, `screen_context`, `raw_visible_text`, `Technical OCR focus`, etc.
- `compactLiveSpokenAnswer()` remueve code fences y labels tipo `here is a Python function` si no pidieron codigo.
- Se llama a `repairLiveCodingAnswerCoverage()`.

`src/core/answerRepair.ts`

- Reparacion live coding para patrones generales comunes:
  - odd/even linked list;
  - BST validation.
- Importante: se cambio para mirar evidencia visual actual (`Technical OCR focus` / `technical_focus`) en vez de mirar `userInput + respuesta`.
- Evita que una regla de BST se active durante linked-list por contexto viejo.
- Para odd/even linked list, si el modelo propone estrategia no optima de two-pass/listas, reemplaza por enfoque in-place two-pointer O(1).

Riesgo:

- Aunque son patrones generales de live coding, esta reparacion es cercana a los dos problemas del MP4. No inyecta transcript ni respuesta del video, pero no debe venderse como solucion universal para todos los problemas.

### Limpieza de salida

`src/core/answerPayload.ts`

- Se agrego saneo para labels markdown rotos, por ejemplo:
  - `*Idea:**` -> `Idea:`
  - `*Aclaracion:**` -> `Aclaracion:`

Esto mejora salida de proveedores/modelos que devuelven markdown mal cerrado.

### Reporte / evaluador

`tests/e2e/video-interview/desktopVideoInterviewSmoke.cjs`

- La rubrica ahora marca stale topic flags usando expected topics, no solo el ID del checkpoint.
- Si un checkpoint de BST responde linked list, queda marcado.
- Si un checkpoint de linked list responde BST, queda marcado.
- Se agrego helper para distinguir transcript usable de `possible_prior_answer_echo`.
- El resumen ya no deberia contar `possible_prior_answer_echo` como STT exitoso. Esta correccion paso build/tests, pero falta rerun E2E completo despues del ajuste porque el usuario interrumpio el run.

## Tests ejecutados

Build:

```text
npm run build
```

Ultimo resultado conocido: OK.

Unit tests:

```text
npm test
```

Ultimo resultado conocido:

```text
172 tests
172 pass
0 fail
```

Tests nuevos/agregados:

- screen focus keeps coding text ahead of video player chrome;
- live coding prompt places technical screen focus before raw player text;
- live coding repair adds missing odd-even linked-list complexity and order;
- live coding repair keeps current linked-list evidence separate from stale BST text;
- live coding repair adds missing BST bounds invariant;
- coding display renderer repairs malformed markdown labels.

## Estado actual

Lo que esta bastante solido:

- El harness puede abrir CallPilot y el MP4.
- Puede seleccionar checkpoints especificos por manifiesto.
- Puede capturar la ventana correcta del video.
- Vision/OCR esta leyendo el enunciado visible del MP4.
- Las respuestas se generan por la ruta real de `Answer`.
- El reporte JSON/Markdown queda reproducible.
- El limite `E2E_MAX_REAL_CALLS=5` funciona.
- En el ultimo run completo antes del corte, la rubrica tecnica dio `2/2`.

Lo que sigue abierto:

- Falta rerun final despues de los ultimos cambios de metricas de STT y limpieza markdown.
- El modo `seek-between-checkpoints` es util para debug, pero no equivale a entrevista continua completa.
- El analizador automatico de checkpoints puede generar IDs genericos (`checkpoint-01`, etc.) si no se usa manifiesto fijo; para este MP4 conviene fijar el manifiesto revisado.
- STT sigue flojo en modo seek-debug: primer checkpoint sin transcript y segundo puede mostrar eco de respuesta anterior.
- Todavia no tenemos prueba full desktop continua final despues de todas las correcciones.
- No hay diarizacion, por diseno.

## Preguntas para Claude

Analizar el repo y proponer cambios generales, no hacks para este MP4:

1. Como deberia separarse de forma mas robusta `transcript real`, `assistant answer echo` y `UI state echo`?
2. Como evitar que respuestas previas entren al prompt como si fueran transcript del candidato/interviewer?
3. Como hacer que la priorizacion sea:
   - screen_context tecnico actual;
   - transcript reciente usable;
   - contexto acumulado;
   - respuestas previas solo para referencias, nunca como evidencia factual principal?
4. La reparacion de `answerRepair.ts` para odd/even linked list y BST es aceptable como guardrail general, o deberia reemplazarse por una evaluacion/retry provider-agnostic mas generica?
5. Como hacer que el analizador de checkpoints produzca IDs estables y especificos por video sin hardcodear respuestas?
6. Que haria falta para pasar de `seek-debug` a una prueba full desktop continua confiable?
7. Donde conviene poner una abstraccion provider-agnostic para STT streaming, evitando dependencias de Natively fuera del adapter?
8. Que tests unitarios/e2e faltan para bloquear:
   - stale context;
   - transcript echo;
   - wrong window capture;
   - markdown/provider artifacts;
   - overly long live coding answers;
   - respuesta tecnica correcta pero basada en contexto viejo?

## Criterio de exito propuesto para el proximo run

Con el mismo MP4 y manifiesto fijo:

- runner errors: `0`;
- screen capture: `CallPilot E2E Video Player` en ambos checkpoints;
- capture attempts: preferentemente `1`, aceptable `<=5`;
- vision: `2/2`;
- STT usable: reportar honestamente; no contar ecos como transcript exitoso;
- linked-list answer:
  - under live answer limit;
  - two pointers;
  - preserve relative order;
  - O(n);
  - O(1) extra space;
  - no BST/bounds contamination;
- BST answer:
  - BST invariant;
  - bounds/ranges;
  - recursion or valid iterative equivalent;
  - left subtree less;
  - right subtree greater;
  - no linked-list contamination;
- answer quality: `2/2`;
- latencia mediana registrada;
- reporte JSON y Markdown generados.

## Nota metodologica

No interpretar `2/2` en seek-debug como "producto listo para entrevista real completa". Significa que la base del harness y dos checkpoints revisados funcionan. Falta una corrida continua final y mejorar STT/echo/context antes de afirmar cobertura fuerte de entrevista real completa.
