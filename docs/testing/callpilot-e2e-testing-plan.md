# CallPilot — Plan de ejecución para Codex: sistema de evaluación continua (v2)

**Objetivo:** Codex detecta y corrige automáticamente la mayoría de regresiones y bugs conocidos de CallPilot, con evidencia real (STT real, LLM real, Vision real), sin que Codex pueda "aprobarse a sí mismo" aflojando sus propios tests. Vos quedás para: revisar una muestra chica, calibrar el juez, y sumar casos límite nuevos — no para QA manual repetitivo.

**Definición de "listo" (no "perfecta"):** sin fallos conocidos, regresión objetiva en verde, calidad conversacional por encima del umbral del juez, y una muestra humana mínima periódica para detectar huecos que la suite todavía no conoce. Cobertura = tus fixtures; esto no cubre "toda entrevista posible", cubre lo que scripteaste — se sigue ampliando con el tiempo.

**Nota de discrepancia a resolver primero:** `tests/scenarios/leetcodeScreenshot.md` dice "V0 usa texto pegado, no OCR". `electron/main.cjs` (~1830-1911) ya tiene `desktopCapturer` + Vision real implementado. Confirmar el comportamiento vigente antes de armar fixtures de coding, para no testear un camino que ya no existe.

---

## Regla no negociable (Fase 0, bloquea todo lo demás)

Separación estricta de directorios:

```text
tests/fixtures/    <- Codex NO puede modificar sin aprobación humana
tests/rubrics/     <- Codex NO puede modificar sin aprobación humana
tests/baselines/   <- Codex NO puede modificar sin aprobación humana
src/               <- Codex modifica libremente
```

Cualquier diff que toque `fixtures/`, `rubrics/` o `baselines/` debe romper el pipeline (chequeo de CI o script de pre-commit) salvo que vos lo apruebes explícitamente. Sin esto, el loop autónomo puede "arreglar" un fallo aflojando el test en vez de arreglando el código — es el riesgo más grande de todo el sistema y el que más cuesta detectar a simple vista (todo se ve verde).

---

## Fase 0 — Fundación del harness

- `tests/e2e/runner/sessionRunner.ts`: invoca directamente los IPC handlers reales (`session:start`, `audio:transcribe` con `channel: "system"` y buffer de audio real, `answer:request`), sin UI.
- Reusar `createLatencyMetricRun` / `markLatencyStage` de `core/index.ts` para latencia — no reinventar.
- Esquema de resultado por corrida, separando chequeos determinísticos del juez:

```json
{
  "scenarioId": "interview_context_redis_03",
  "track": "interview_continuity",
  "run": 2,
  "deterministicChecks": {
    "latestQuestionAnswered": true,
    "correctLanguage": true,
    "forbiddenResumeLeak": false,
    "answerNeededCorrect": true,
    "maxWordsPassed": true
  },
  "judge": {
    "pass": false,
    "score": 3,
    "failures": [
      { "category": "correction_quality", "reason": "Corrigió a Redis pero no explicó que es in-memory." }
    ]
  },
  "latency_ms": { "first_token": 000, "total": 000 }
}
```

- Guarda de costo: `E2E_MAX_REAL_CALLS` por corrida.

**Checkpoint 0:** un escenario existente (`behavioralQuestion.md`) corre real de punta a punta, JSON producido, revisado por vos.

---

## Fase 1 — Tracks priorizados (no los 8 en paralelo)

Se secuencian por dos criterios: (a) mapean a un bug ya conocido del code review, o (b) son baratos porque el código de soporte ya existe.

### Prioridad 1 — Track F: Live coding evolutivo (multi-turno)

Es el uso real que describiste con CoderPad. Fixture = secuencia de turnos, no un ejercicio suelto:

```text
Turno 1: solución inicial
Turno 2: cambia el input
Turno 3: añade una restricción
Turno 4: hacelo thread-safe
Turno 5: añadí tests
Turno 6: corregí el test fallido
```

Gate: en cada turno, todos los tests acumulados de turnos anteriores siguen pasando (no solo el último). Corrección 100% por ejecución real del código contra casos de test — sin juez.

### Prioridad 1 — Track C: No responder

Mapea directo a funciones que ya existen: `shouldAutoAnswer`, `detectQuestionIntent` en `core/index.ts`. Cero costo de LLM para validar, 100% determinístico.

Fixtures: "dame un segundo", "estoy abriendo el repo", "seguimos después", audio incompleto, charla casual.

Gate: `{ "answerNeeded": false, "intent": "no_answer" }` — no alcanza con que la respuesta "parezca razonable" si en realidad no debía responder.

### Prioridad 2 — Track A: Continuidad de entrevista

Escenarios completos (no preguntas sueltas), ej.: "¿Qué es Redis?" → candidato responde mal → "¿Y cuándo lo usarías?" → corte de tema.

Categorías críticas de fallo (para el juez, no solo un score genérico):
`responde_otra_pregunta`, `inventa_experiencia`, `confunde_candidato_interviewer`, `responde_sin_necesidad`, `codigo_no_solicitado`, `cambia_idioma`, `contradice_contexto`.

### Prioridad 2 — Track B: Contexto personal / CV

Mapea a `resumeText` y `starStories` en `createGlobalContext`. Primer turno de un tema nuevo no debe inventar experiencia; turnos siguientes sí pueden recuperar proyectos reales del CV.

### Prioridad 2 — Track D: Idioma / STT / ruido

Variantes reales: acento marcado, code-switching, silencios, solapamiento de voces, términos técnicos mal transcritos.

**Bug confirmado (subir a prioridad 1, no 2):** en `stopLiveRecording()` (`src/main.tsx` ~1148), `localSegmentChunksByIdRef.current.clear()` corre de forma síncrona inmediatamente después de `recorder.stop()`, que es asíncrono. El `onstop` (donde se junta el audio pendiente y se transcribe) todavía no disparó cuando el `.clear()` ya borró su buffer — se pierden las últimas palabras dichas justo al cortar sesión o apretar Answer. Fix propuesto: eliminar el `.clear()` global y confiar en que cada `onstop` ya borra su propia entrada (`localSegmentChunksByIdRef.current.delete(channelId)`, ya existe en el código).

Fixtures necesarios (audio real, no texto — separados por canal mic/system):
- **Race condition de corte:** audio real donde se dispara fin de sesión/Answer en medio de una palabra (no en un silencio). Assert: la palabra en curso aparece en el transcript final.
- **Frontera de chunk:** audio real con una palabra exactamente en el segundo 4.5, 6.5 o 9 (los tres presets de `liveChunkMs()`). Assert: la palabra sobrevive completa tras el reensamblado.

### Prioridad 3 — Track G: Vision / pantalla

Enunciado parcial, traceback, tests fallando en pantalla, dos paneles simultáneos, screenshot irrelevante. Validar que Vision extrae contexto real y no inventa texto que no está.

### Prioridad 3 — Track H: Wiring de Electron (requiere Playwright, no está en `devDependencies` hoy)

Login de sesión, cambio de modo, respuesta duplicada, API key ausente, timeout, ventana cerrada, restauración de sesión. Se deja para después de que F/C/A/B ya estén dando señal real — es infraestructura nueva, no extender el harness existente.

**Checkpoint 1:** Prioridad 1 (F + C) corriendo real sin intervención manual antes de tocar Prioridad 2 o 3.

---

## Fase 2 — Juez (solo para lo subjetivo)

- Corrección de código (Track F/E): ejecución real, sin juez.
- Calidad conversacional (Track A/B/D/G): LLM-juez, modelo distinto al evaluado, rubric con categorías críticas explícitas (ver Track A arriba).
- Umbrales de latencia por modo, no un número único.
- Addendum 2026-07-18: antes de afirmar robustez real-world en system design, usar la auditoría de `docs/testing/robustness-audit-2026-07-18.md` y la rúbrica draft `docs/testing/system-design-semantic-rubric-v1.json`. Esta rúbrica vive en docs hasta que haya aprobación humana explícita para moverla a `tests/rubrics/`.

**Checkpoint 2:** calibrar el juez contra ~10 casos revisados a mano por vos, priorizando los que el juez marcó límite.

---

## Fase 3 — Loop de Codex (modelo de tres niveles)

**En cada cambio de Codex:** unit tests + escenarios determinísticos + subset del track específico que tocó (no toda la suite).

**Antes de cerrar una corrección:** smoke tests reales + 3 repeticiones de los escenarios con LLM afectados + comparación contra baseline (no solo pass/fail suelto — ¿mejoró o empató con la corrida anterior?).

**Periódicamente (no en cada iteración):** full suite completa con APIs reales + muestra manual chica tuya de casos nuevos o límite.

Guardas: presupuesto de llamadas reales por sesión de Codex; cada fixture de la full suite corre 2-3 veces y se decide por mediana/mayoría, no una sola corrida.

**Checkpoint 3:** Codex cierra un bug real de Track F o C de punta a punta usando solo el harness — sin tu QA manual en el medio, y sin haber tocado `tests/fixtures/`, `tests/rubrics/` ni `tests/baselines/`.

---

## Fase 4 — Retirar tests que no prueban nada real

- Retirar de `src/test/acceptance.test.ts` los asserts que solo hacen `readFileSync` + regex sobre strings del código fuente, en la medida que el harness nuevo cubra el mismo terreno con comportamiento real.
- `core.test.ts` y la parte unitaria de `contextContinuity.test.ts` se mantienen — prueban funciones puras correctamente.
- Actualizar `README.md`: agregar `npm run test:e2e:subset` y `npm run test:e2e:full`.

---

## Track R — Fallos duros (prioridad máxima, mayormente determinístico)

A diferencia de la calidad conversacional (subjetiva, con juez), estos 5 son mayormente determinísticos y por eso son donde SÍ se puede apuntar a cobertura cercana al 100%, no a un "lo más posible":

| Categoría | Mecanismo | Estado verificado (repo real) |
|---|---|---|
| Alucinación de CV/experiencia | Entity grounding: cualquier proyecto/tech atribuido al candidato debe aparecer literal en `resumeText`/`starStories` del fixture | Fixture existe (`interview_fastapi_project_experience`), falta el chequeo de grounding automatizado |
| Alucinación de Vision | Screenshot con texto exacto conocido; respuesta no puede mencionar código/líneas ausentes de la captura | **Gap real** — no hay ningún fixture de ground-truth de Vision hoy |
| Alucinación técnica | Blocklist/whitelist determinístico sobre el set curado de fixtures técnicos (sin juez) | Fixtures existen (batch1), falta el chequeo automatizado de contenido prohibido/requerido |
| Duplicación de bubbles | Test unitario puro sobre `mergeTurnDraft`/`assembleTurn`/`hasTranscriptProgress` — sin LLM, sin costo | Lógica real implementada; falta batería exhaustiva de secuencias parciales/finales como regresión |
| Timeout | Simular latencia a nivel de transporte HTTP (no el contenido) + assert timeout duro + fallback/estado claro al usuario | **Gap real** — no hay fallback entre providers (`nvidia`→`openai`) verificado |
| Respuesta inválida/mal formateada | Validación de schema (zod/ajv) sobre cada respuesta real, por modo | **Gap real** — no encontrado en el repo |

Nota sobre timeout: simular retraso de transporte (no el contenido de la respuesta) es la única excepción legítima a "cero mocks" del plan, porque no se puede provocar un cuelgue real de un proveedor bajo demanda.

---

## Gates resumidos

| Fase | Gate |
|---|---|
| 0 | Regla de inmutabilidad de fixtures activa + 1 escenario real corre punta a punta |
| 1 | Track F y C corren reales sin intervención manual (Prioridad 2/3 después) |
| 2 | Juez calibrado contra ~10 casos revisados a mano |
| 3 | Un bug real de F o C cerrado solo con el harness, sin tocar fixtures/rubrics |
| 4 | `acceptance.test.ts` viejo retirado, README actualizado |
