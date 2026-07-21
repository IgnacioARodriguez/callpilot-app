## Veredicto

Puedo continuar el trabajo de Claude, pero hay que corregir el objetivo: **“confianza absoluta” no existe en un sistema probabilístico expuesto a entrevistas arbitrarias**. Lo que sí podés conseguir es una confianza operacional muy alta dentro de un alcance explícito, con evidencia estadística y sin tener que mirar personalmente horas enteras de entrevistas.

El análisis de Claude es esencialmente correcto: actualmente hay infraestructura valiosa, pero todavía se está optimizando demasiado contra casos conocidos. 

Además, encontré dos matices importantes:

1. No todos los runners NVIDIA usan el mismo modelo. El runner general puede elegir `nvidia/llama-3.3-nemotron-super-49b-v1`, mientras que los E2E de video y algunos tracks reales usan por defecto `meta/llama-3.1-8b-instruct`. Por lo tanto, los resultados actuales no son comparables entre sí.
2. En el último hardening se aumentaron algunos límites de latencia de 12 a 30 segundos para hacer pasar escenarios CoderPad. Eso contradice el propio DoD, que establece 12 segundos para solución completa y hard fail después de 15. **Mover el límite para poner verde el test es falsa confianza.**

---

# La estrategia definitiva

CallPilot no necesita más escenarios sueltos. Necesita pasar de un **repositorio de tests** a un **sistema de evaluación experimental**.

La unidad central ya no debe ser “un prompt que falló”, sino:

> Una situación de entrevista reproducible, con evidencia disponible hasta ese instante, comportamiento esperado, errores prohibidos y métricas objetivas.

## Arquitectura de confianza

| Capa              | Qué verifica                         | Evaluación             |
| ----------------- | ------------------------------------ | ---------------------- |
| 1. Determinista   | Estado, parser, resets, schemas      | Unit/integration tests |
| 2. Semántica      | Relevancia, corrección, no invención | Judge con rúbrica      |
| 3. Ejecutable     | Código realmente correcto            | Sandbox + tests        |
| 4. Replay         | Audio + pantalla + tiempos reales    | Reproducción de MP4    |
| 5. Generalización | Que no memorice el corpus            | Holdout + mutaciones   |
| 6. Estadística    | Variabilidad entre corridas          | Repeticiones y tasas   |
| 7. Producción     | Casos inesperados                    | Telemetría anonimizada |

Ahora tenés partes de las capas 1, 3 y 4. Lo que falta principalmente es **holdout, mutación, separación raw/recovered y evaluación estadística**.

---

# 1. Convertir tus MP4 en un dataset de replay

Ya existe buena parte de la infraestructura necesaria:

* `analyzeLocalVideo.cjs` abre el video, extrae frames, ejecuta OCR, detecta cambios visuales y propone checkpoints.
* `localVideoInterviewRunner.cjs` puede reproducir el video, cortar audio anterior al checkpoint, ejecutar STT, visión y generación de respuesta.
* Hay comandos para análisis y reproducción local.

No hay que reemplazar esto. Hay que transformarlo en una pipeline formal:

```text
MP4
 ├─ audio continuo
 ├─ frames relevantes
 ├─ OCR bruto
 ├─ transcript acumulado
 ├─ checkpoints Answer
 └─ manifest evaluable
```

Cada checkpoint debería contener:

```json
{
  "video_id": "interview_07",
  "checkpoint_id": "cp_04",
  "timestamp_ms": 486000,
  "mode": "live_coding",
  "available_transcript": "...",
  "available_screen_text": "...",
  "visible_frame": "...",
  "expected_intent": "debug_fix",
  "required_facts": [
    "duplicate values are allowed",
    "cannot reuse the same index"
  ],
  "forbidden_facts": [
    "content appearing later in the video",
    "previous Redis question"
  ],
  "executable_contract": {
    "language": "python",
    "function": "two_sum",
    "tests": ["..."]
  },
  "severity_if_failed": "P0"
}
```

### Trabajo manual requerido

No tenés que mirar la entrevista completa muchas veces.

Hay que hacer una única anotación inicial:

* marcar entre 4 y 10 checkpoints relevantes por video;
* escribir qué tenía que entender CallPilot;
* marcar hechos prohibidos;
* agregar tests ejecutables cuando haya código.

Con 8 videos y 6 checkpoints por video obtenés unas 48 situaciones reales. Eso es mucho más valioso que 200 prompts inventados.

---

# 2. Dividir el corpus para impedir el overfitting

Este es el cambio más importante.

## División obligatoria

```text
development/
  Casos visibles para Codex y para vos.
  Se usan para depurar.

validation/
  Casos que se pueden ejecutar durante el desarrollo,
  pero no se usan para escribir reglas específicas.

holdout/
  Videos y problemas que Codex no debe inspeccionar.
  Solo se ejecutan para decidir release.
```

La división debe hacerse **por entrevista completa**, no por checkpoint. Si varios checkpoints del mismo MP4 quedan en development y holdout, existe filtración de contexto.

Distribución recomendada:

* 60% development.
* 20% validation.
* 20% holdout.

Cuando falle un caso del holdout:

1. clasificás la causa;
2. no copiás su texto al prompt ni a una regex;
3. construís una solución general;
4. agregás un caso equivalente, pero diferente, a development;
5. el caso original permanece en holdout.

De esta manera Codex no puede “aprender el examen”.

---

# 3. Eliminar los repairs semánticos

Actualmente `repairSystemDesignAnswerCoverage` reemplaza ideas sobre Redis y agrega contenido específico cuando detecta términos concretos. `repairTechnicalDebuggingAnswerCoverage` agrega `tracemalloc`, snapshots, RSS y objetos retenidos en preguntas de memory leaks. Esto significa que parte del resultado evaluado no salió del modelo.

Debe aplicarse esta regla:

### Repairs permitidos

* cerrar JSON truncado;
* normalizar tipos;
* recuperar campos estructurales;
* corregir escaping;
* pedir nuevamente una respuesta incompleta.

### Repairs prohibidos

* agregar una tecnología;
* agregar un razonamiento;
* corregir una decisión arquitectónica;
* insertar una solución canónica;
* completar puntos que el modelo omitió.

Además, el runner actualmente puede hacer el primer intento, completeness retry y hasta dos intentos adicionales después de una ejecución fallida. El resultado final puede pasar después de varios fallos invisibles.

El reporte debe separar:

```json
{
  "raw_model_pass": false,
  "recovered_pass": true,
  "retry_count": 2,
  "repairs": [
    "structured_json_repair",
    "executable_retry"
  ]
}
```

El release gate debe basarse principalmente en `raw_model_pass`.

Un repair puede salvar al usuario durante una entrevista, pero **no puede contarse como evidencia de que el modelo es confiable**.

---

# 4. Evaluar la respuesta con tres clases de scorer

No sirve usar solamente keywords como `hash`, `tuple`, `O(n)`.

## A. Scorers deterministas

Para todo:

* schema válido;
* respuesta no vacía;
* función correcta;
* no stale state;
* no contenido futuro;
* idioma;
* límite de longitud;
* response type;
* patch requerido;
* latencia;
* cantidad de retries y repairs.

## B. Scorers ejecutables

Para código:

* sintaxis;
* tests públicos;
* tests ocultos;
* property-based tests;
* timeout;
* memoria;
* mutación del input;
* firma exacta;
* complejidad cuando pueda verificarse.

El runner ya ejecuta Python mediante `spawnSync`, pero todavía se utiliza solo cuando el escenario trae `executableAssertions`.

Para live coding, el objetivo debe ser:

* 100% de los problemas ejecutables tienen tests.
* No más keyword-only pass para código.
* Al menos 30% de los tests son propiedades generadas, no ejemplos copiados.

Ejemplo para Two Sum:

```python
for random_case in generated_cases:
    result = two_sum(nums, target)

    if result is None:
        assert no_valid_pair_exists(nums, target)
    else:
        i, j = result
        assert i != j
        assert nums[i] + nums[j] == target
```

## C. Judge semántico

El judge debe evaluar mediante una rúbrica, no comparar contra una respuesta textual ideal:

* ¿respondió la pregunta vigente?
* ¿utilizó la pantalla correctamente?
* ¿ignoró el contexto viejo?
* ¿inventó restricciones?
* ¿la explicación es decible?
* ¿el patch conserva el comportamiento anterior?
* ¿la complejidad es correcta?
* ¿debió pedir aclaración?

OpenAI dispone de graders deterministas, de similitud y de modelo, con soporte para texto, imágenes y audio en graders de modelo. Eso encaja especialmente bien con checkpoints derivados de los MP4. ([OpenAI Platform][1])

El judge no debe ser el mismo modelo que genera la respuesta. Para casos críticos:

```text
generator: modelo de producción
judge A: modelo fuerte OpenAI
judge B: otro modelo/familia
deterministic scorer
```

P0 si falla un scorer objetivo o si ambos judges coinciden.

---

# 5. Generar variaciones automáticamente

Para no tener que conseguir cientos de entrevistas, cada checkpoint real debe generar mutaciones.

## Mutaciones de pantalla

* dark/light mode;
* zoom 80%, 100%, 125%;
* crop parcial;
* blur;
* compresión;
* OCR con caracteres confundidos;
* sidebar abierta;
* chat visible;
* consola visible;
* statement parcial;
* línea de código cortada;
* pantalla anterior mezclada;
* notificaciones;
* navegador distinto.

## Mutaciones de audio

* ruido;
* eco;
* caída de palabras;
* cambio de acento;
* interviewer/candidate superpuestos;
* pausa larga;
* pregunta reformulada;
* palabra crítica en borde de chunk;
* click en Answer antes de terminar la frase;
* charla trivial antes de la pregunta.

## Mutaciones semánticas

* cambiar nombres de funciones;
* cambiar ejemplos;
* cambiar números;
* cambiar lenguaje;
* invertir el orden de restricciones;
* añadir un requisito tardío;
* introducir una corrección del interviewer;
* reemplazar el problema por uno estructuralmente equivalente.

Esto es mucho más robusto que agregar 100 fixtures manuales.

Promptfoo puede ejecutar matrices de modelos/prompts, validaciones personalizadas y generación adversarial; sería útil para esta capa, aunque no reemplaza tu replay de Electron. ([Promptfoo][2])

---

# 6. Definir una confianza estadística real

“Pasó una vez” no significa nada.

Para cada caso crítico:

* development: 1 corrida rápida;
* validation: 3 corridas;
* holdout: 5 corridas;
* casos históricamente inestables: 10 corridas.

Para cero fallos observados, la regla aproximada del 95% es:

```text
límite superior de tasa de fallo ≈ 3 / número de corridas
```

Por lo tanto:

* 100 corridas sin P0 → todavía podría haber aproximadamente 3% de P0.
* 300 corridas sin P0 → aproximadamente menos de 1%.
* 600 corridas sin P0 → aproximadamente menos de 0,5%.

No necesitás 300 entrevistas distintas. Podrían ser, por ejemplo:

```text
50 checkpoints holdout
× 3 mutaciones seleccionadas
× 2 corridas
= 300 corridas
```

La parte humana se limita a anotar y calibrar una muestra; las corridas se automatizan.

---

# Release gate definitivo

## CallPilot “Trusted — Python Backend Interviews”

No debe declararse confiable universalmente. Debe declararse confiable para un alcance:

```text
Python
SQL/PostgreSQL
APIs backend
debugging
live coding Python
system design backend común
entrevistas en español o inglés
```

### Gate P0

* 0 respuestas a tema anterior en holdout.
* 0 experiencias inventadas.
* 0 restricciones o código visible inventado.
* 0 soluciones ejecutables incorrectas aceptadas como correctas.
* 0 contaminación después de Nuevo ejercicio.
* 0 contaminación después de Nueva sesión.
* 0 uso de información futura del video.

### Gate de calidad

* `raw_model_pass` ≥ 95%.
* `recovered_pass` ≥ 99%.
* Código ejecutable ≥ 97%.
* Follow-up conserva tests anteriores ≥ 98%.
* Judge semántico ≥ 90/100.
* Disagreement entre judges < 5%.
* Parser-repair rate < 1%.
* Semantic-repair rate = 0%.
* Retry rate < 5%.

### Gate de latencia

* Q&A P95 completo ≤ 3,5 segundos.
* Primer fragmento usable ≤ 2 segundos.
* Small coding fix P95 ≤ 6 segundos.
* Full coding solution P95 ≤ 12 segundos.
* Nunca modificar el límite del escenario para conseguir verde.

### Gate estadístico

* mínimo 300 ejecuciones holdout sin P0;
* mínimo 5 videos reales no utilizados durante el desarrollo;
* mínimo 3 plataformas o layouts;
* mínimo 3 perfiles de audio;
* mínimo 2 modelos/judges independientes.

---

# Qué implementaría ahora, en orden

## Fase 1 — Dejar de falsear la medición

1. Eliminar repairs semánticos de `answerRepair.ts`.
2. Reportar raw, parsed, repaired y final por separado.
3. Guardar `retry_count` y `repair_types`.
4. Revertir latencias de 30 segundos a los límites del DoD.
5. Fijar explícitamente modelo y configuración en cada reporte.

## Fase 2 — Dataset real

Crear:

```text
tests/eval/
  datasets/
    development.jsonl
    validation.jsonl
    holdout.jsonl
  videos/
    manifests/
  mutations/
  rubrics/
```

Adaptar el analizador de video actual para exportar directamente este formato.

## Fase 3 — Runner único

Unificar progresivamente:

```text
scripts/run-llm-scenarios.mjs
tests/e2e/runner/sessionRunner.ts
tests/e2e/video-interview/localVideoInterviewRunner.cjs
```

No necesariamente en un archivo, sino detrás de un mismo contrato de resultado.

```json
{
  "input",
  "raw_output",
  "parsed_output",
  "recovered_output",
  "deterministic_scores",
  "execution_scores",
  "judge_scores",
  "latency",
  "trace",
  "artifacts"
}
```

## Fase 4 — CI

Actualmente CI solo ejecuta tests, protected assets, benchmark y build. No ejecuta los tracks reales.

Agregar:

```text
PR:
  unit
  parser
  state
  development eval
  10-20 casos sin llamadas costosas

Nightly:
  validation
  modelos reales
  3 repeticiones
  mutaciones

Weekly/release:
  holdout
  MP4 replay completo
  strict latency
  judges
  5-10 repeticiones
```

Los reports tampoco deberían perderse en carpetas ignoradas: actualmente se ignoran los resultados LLM, E2E y video.

Subirlos como artifacts de CI o almacenarlos como experimentos.

Braintrust encaja para datasets versionados, experimentos inmutables, comparación de ejecuciones y CI. No subiría los MP4: solamente manifests y trazas redactadas. ([Braintrust][3])

---

# La decisión concreta

**No sigas agregando parches CoderPad ahora.**

El siguiente sprint debería estar dedicado exclusivamente a construir el sistema de evaluación:

1. separación development/validation/holdout;
2. ingestión de MP4 a checkpoints;
3. raw versus recovered metrics;
4. repairs semánticos eliminados;
5. scorer ejecutable y judge;
6. mutaciones automáticas;
7. CI con reports históricos;
8. release gate estadístico.

Después de eso, cada cambio tendrá una respuesta objetiva:

```text
Antes:
P0 rate: 1.2%
Executable pass: 91%
Stale context: 3 casos
P95: 14.8s

Después:
P0 rate: 0%
Executable pass: 98%
Stale context: 0 casos
P95: 8.9s
```

Ahí dejás de iterar por sensaciones.

**Respuesta final:** hoy están construyendo componentes que pueden producir confianza real, pero el proceso todavía premia pasar tests tuneados. La transición ocurre cuando Codex deja de ver el examen, los repairs dejan de esconder fallos y los MP4 reales se convierten en un holdout reproducible con evaluación automática. Esa es la frontera entre “más tests verdes” y evidencia legítima de confiabilidad.

[1]: https://platform.openai.com/docs/api-reference/graders?api-mode=chat&utm_source=chatgpt.com "Graders | OpenAI API Reference"
[2]: https://www.promptfoo.dev/docs/configuration/expected-outputs/?utm_source=chatgpt.com "Assertions and Metrics - LLM Output Validation | Promptfoo"
[3]: https://www.braintrust.dev/docs/guides/datasets?utm_source=chatgpt.com "Datasets - Braintrust"
