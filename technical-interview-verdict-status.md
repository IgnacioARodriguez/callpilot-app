# Estado de las correcciones del veredicto

## Verificado

- `Answer` sin texto manual usa la pregunta vigente del `TranscriptBuffer` para `latest_actionable_input`.
- El ultimo texto del candidato ya no reemplaza la pregunta del interviewer.
- Fragmentos consecutivos del interviewer se agrupan cuando forman un mismo turno.
- Embeddings y grounding reciben la misma pregunta efectiva.
- Las preguntas tecnicas de uso o experiencia incluyen contexto personal cuando corresponde.
- Afirmaciones personales, herramientas o metricas no respaldadas pasan por el guard de grounding.
- El transcript simulado llega al `TranscriptBuffer` principal y al overlay mediante IPC.

## Pruebas locales

- `npm test`: 280 tests, 280 passed, 0 failed.
- `npm run build`: correcto.

## P1 implementado parcialmente

Se agregó `src/core/adaptiveInterview.ts`, una política genérica que decide entre aclarar alcance, profundizar mecanismo, desafiar trade-offs, reparar una afirmación o cerrar el tema según la respuesta completada. La aplicación registra esa decisión en `answer_generation_linked`, junto con `requestId` y la pregunta efectiva.

Esto elimina la dependencia de una secuencia Prometheus fija dentro del razonamiento de CallPilot, pero todavía no hace que la aplicación controle al interviewer: el controlador E2E debe consumir esa decisión para elegir la siguiente rama.

## Pendiente antes de declarar cerrado el problema

- La cadena Prometheus debe ser adaptativa: la repregunta tiene que depender de la generacion anterior completada, no solo del corpus preordenado.
- Hay que relacionar explicitamente cada `Answer`, generacion completada y turno posterior del candidato en los logs.
- Hay que repetir la entrevista larga con Natively real y verificar 30/30 generaciones completadas, cero `answer_in_progress` y ausencia de repeticion fuera de contexto.

La prueba E2E anterior sigue siendo una referencia historica; no se debe usar como evidencia de que esos tres puntos pendientes ya estan resueltos.

## E2E adaptativa ejecutada

Reporte real: `C:\Users\Asus\AppData\Roaming\callpilot-v0\reports\sessions\session-2026-08-06T13-13-11-382Z-a54b1f.metrics.json`

- 100 transcripts de interviewer y 100 de candidate.
- 30 `manual_answer_requested`, 30 generaciones iniciadas y 30 completadas.
- 0 `manual_answer_ignored` por `answer_in_progress`.
- 30 `answer_generation_linked` y 30 decisiones de grounding.
- Compaction aplicada en 29 de 30 contextos; máximo transcript observado: 32100 caracteres.
- `session_ended` presente y estado final `ended`.
- Políticas adaptativas observadas: `clarify_scope` y `challenge_tradeoff`.
