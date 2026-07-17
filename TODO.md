# CallPilot TODO

Backlog vivo para ideas, mejoras, experimentos y decisiones pendientes.  
No es un plan cerrado: es el lugar para capturar cosas que valen la pena retomar sin perder contexto.

## Como Usar Este Documento

- Agregar ideas aunque esten verdes o incompletas.
- Mover a "Ahora" solo lo que realmente queremos atacar pronto.
- Mantener decisiones importantes con contexto: por que importa, que opciones hay, y como sabremos si funciono.
- No mezclar aca cambios aprobados sobre fixtures/rubrics/baselines; esos deben seguir su proceso protegido.

## Ahora

_Sin items activos._

## Proximas Ideas

### Comparacion de Proveedores y Modelos

**Objetivo:** elegir el mejor balance entre calidad, latencia, formato estructurado, costo y robustez para CallPilot.

**Motivacion:** hoy NVIDIA funciona, pero vimos variabilidad de latencia y algunos aborts/timeouts en escenarios complejos. Probablemente convenga comparar contra OpenAI y otros modelos antes de decidir proveedor principal.

**Principio:** los tests deben ser agnosticos al proveedor. Fixtures, checks, rubrics y umbrales no deberian cambiar si cambiamos de modelo.

**Idea de implementacion:**

- Agregar flags al harness:
  - `--answer-provider`
  - `--answer-model`
  - `--vision-provider`
  - `--vision-model`
  - `--judge-provider`
  - `--judge-model`
- Guardar proveedor/modelo en cada resultado.
- Mantener el mismo schema de reporte para todos.
- Separar adapters de proveedor de los checks deterministas.

**Bakeoff inicial:**

- 3 escenarios interview normales.
- 2 escenarios adversariales.
- 2 escenarios live coding.
- 2 escenarios Vision.
- 1 corrida por modelo para filtrar rapido.

**Finalistas:**

- Top 2 modelos.
- 15-20 escenarios.
- 3 repeticiones.
- Comparar mayoria/mediana, no una sola corrida.

**Metricas de decision:**

- Pass rate deterministico.
- Calidad del juez en categorias criticas.
- Latencia p50/p95.
- Cumplimiento de schema/formato.
- Costo por corrida.
- Estabilidad ante retries/timeouts.

**Notas:**

- OpenAI probablemente sea candidato fuerte para razonamiento, formato y latencia.
- Vision puede requerir un modelo distinto al de respuestas.
- El juez debe ser distinto al modelo evaluado.

## Producto

_Agregar ideas de UX, flujos, modos de entrevista, overlay, privacidad, sesiones, etc._

## Calidad y Robustez

_Agregar bugs conocidos, regresiones posibles, mejoras de reliability, manejo de timeouts, fallbacks, telemetria, etc._

## Performance y Latencia

_Agregar optimizaciones de tiempo de respuesta, warmups, streaming, cache, reduccion de prompt, modelos alternativos, etc._

## Evaluacion y QA

_Agregar mejoras del harness, nuevos tracks, nuevas metricas o criterios de cierre._

## Investigacion

_Agregar cosas para explorar sin compromiso inmediato._

## Decisiones Pendientes

| Decision | Opciones | Criterio | Estado |
|---|---|---|---|
| Proveedor principal de respuestas | NVIDIA, OpenAI, otro | Calidad + latencia + formato + costo | Pendiente |
| Proveedor principal de Vision | NVIDIA Vision, OpenAI Vision, otro | OCR exacto + no alucinacion + latencia | Pendiente |

## Archivo

_Items cerrados o descartados, con una linea de contexto._

