# Reproducción de la prueba E2E de Technical Interview

## Objetivo

Reproducir una entrevista técnica stateful usando la aplicación real y sus módulos reales. La única parte simulada es la entrada de audio/transcript del interviewer y del candidato.

El flujo que se debe validar es:

`transcript simulado -> TranscriptBuffer real -> latest actionable context -> compaction/grounding -> Natively -> respuesta real en overlay -> siguiente turno`

No se debe usar un runner que siembre directamente una sesión, construya prompts fuera de la aplicación o envíe mensajes únicamente al overlay.

## Archivos relevantes

- `src/main.tsx`: estado del transcript, construcción de contexto, manual Answer y pipeline de respuesta.
- `src/overlay/OverlayApp.tsx`: renderizado de las burbujas y respuestas.
- `electron/main.cjs`: IPC, trazas, creación de ventanas y proveedores.
- `electron/preload.cjs`: bridge de la aplicación.
- `src/core/transcriptBuffer.ts`: almacenamiento y deduplicación de turnos.
- `src/audio/liveAudioProcessor.ts`: procesamiento PCM real.
- `technical-interview-corpus-review-v2.md`: corpus base de 100 pares lineales.
- `C:\Users\Asus\Downloads\callpilot_e2e_interview_simulation_v2.md`: especificación stateful usada para diseñar la prueba.

## Corrección necesaria para el input simulado

El bridge `transcript:publish` originalmente enviaba el mensaje solamente al overlay. Eso hacía que la burbuja apareciera en pantalla, pero `main.tsx` mantenía el transcript vacío. El razonamiento recibía únicamente `manual-question` y producía respuestas genéricas.

La corrección aplicada es:

1. El input de prueba lleva `simulation: true`.
2. `electron/main.cjs` sigue enviando el mensaje al overlay y además lo envía al renderer principal cuando está marcado como simulación.
3. `src/main.tsx` escucha ese evento y agrega el turno al `TranscriptBuffer` real.
4. Los transcripts reales de Deepgram no cambian de comportamiento.

No se debe eliminar esta separación: una transcripción real no debe republicarse a sí misma y crear un loop.

## Configuración

La configuración esperada para Technical Interview es:

```text
activeMode: technical_qa
modelProvider: natively
liveTranscriptionProvider: deepgram
liveAudioSource: both
autoAnswer: false
```

Natively se usa para las respuestas. Deepgram se mantiene como proveedor de transcript real cuando se usa audio real. En esta prueba el audio se reemplaza por eventos de transcript simulados, pero el resto del flujo permanece real.

Las credenciales deben estar disponibles mediante la configuración normal de CallPilot, no hardcodeadas en el runner.

## Preparación

Desde PowerShell:

```powershell
cd C:\Projects\callpilot-v0\callpilot-app
Get-Process electron,node -ErrorAction SilentlyContinue | Stop-Process -Force
npm run build
```

El build debe terminar correctamente antes de ejecutar la prueba.

## Lanzamiento reproducible

Levantar Vite:

```powershell
$args='/c','start "Vite" /D "C:\Projects\callpilot-v0\callpilot-app" npm run dev -- --port 5174 --strictPort'
Start-Process cmd.exe -ArgumentList $args -WorkingDirectory 'C:\Projects\callpilot-v0\callpilot-app'
```

Levantar Electron con la URL de desarrollo y CDP habilitado:

```powershell
$args='/c','set VITE_DEV_SERVER_URL=http://127.0.0.1:5174&&start "CallPilotDev" /D "C:\Projects\callpilot-v0\callpilot-app" "C:\Projects\callpilot-v0\callpilot-app\node_modules\electron\dist\electron.exe" . --remote-debugging-port=9339'
Start-Process cmd.exe -ArgumentList $args -WorkingDirectory 'C:\Projects\callpilot-v0\callpilot-app'
```

Verificar:

```powershell
Get-NetTCPConnection -LocalPort 5174,9339
Invoke-RestMethod http://127.0.0.1:9339/json/list
```

La ventana principal debe aparecer con URL `http://127.0.0.1:5174/`.

## Inicio desde la UI real

Desde la ventana principal real:

1. Seleccionar `Technical Interview`.
2. Confirmar que el proveedor de respuestas sea `Natively`.
3. Confirmar que `Auto-answer` esté desactivado.
4. Pulsar `Start interview overlay`.
5. Esperar a que la sesión pase a `Listening`.

No se debe crear una sesión con `seedSessionExpression`, `makeSession`, `session:start` directo ni ningún helper que evite estos pasos.

## Corpus y manifest

La prueba stateful usada tuvo:

```text
seed: callpilot-technical-interview-v2
logical turns: 60
transcript fragments: 136
manual Answer actions: 30
interviewer fragments: 70 aproximadamente
candidate turns: 60
```

El manifest se registra en la traza como `test_manifest` y debe incluir la seed, el número de turnos, fragmentos, acciones y posiciones de Answer.

La cadena obligatoria de Prometheus debe respetar esta causalidad:

1. Interviewer: pregunta fragmentada sobre Prometheus.
2. Candidate: responde que sí, pero con alcance parcial.
3. `Answer` manual.
4. CallPilot genera una explicación en primera persona.
5. Interviewer repregunta sobre PromQL, scrape health o Alertmanager.
6. Candidate responde usando o corrigiendo la sugerencia.
7. Otra repregunta puede cuestionar una afirmación demasiado segura.

El candidato no debe recibir la respuesta de CallPilot como una pregunta nueva. Si se simula que utiliza la respuesta, debe publicarse como un nuevo turno `candidate` después de `generation.completed`.

## Orden temporal

Cada ciclo debe seguir esta secuencia:

```text
interviewer fragment(s)
candidate fragment/answer
Answer manual
esperar generation.completed
candidate usa o corrige la sugerencia
interviewer repregunta
```

Nunca se deben publicar todos los transcripts y después disparar todas las respuestas. Eso hace que el sistema pierda la pregunta activa y responda sobre el último estado disponible.

Tampoco se debe disparar otro `Answer` mientras exista una respuesta activa. El trace debe contener cero eventos `manual_answer_ignored` con razón `answer_in_progress`.

## Métricas y eventos que deben auditarse

Eventos mínimos:

- `session_started`
- `test_manifest`
- `transcript_final`
- `manual_answer_requested`
- `manual_answer_ignored`
- `answer_context_built`
- `model_generate_started`
- `provider_request_started`
- `provider_response_headers`
- `model_generate_completed`
- `answer_structured_published`
- `answer_raw_model_output`
- `answer_timing`
- `system_metrics`

Validaciones:

- cantidad esperada de transcripts;
- exactamente 30 solicitudes manuales;
- cero solicitudes ignoradas por respuesta en progreso;
- una generación Natively por acción aceptada;
- respuestas completadas y no solo requests iniciadas;
- `transcriptCharacterCount` mayor que cero;
- `includedTurnIds` conteniendo turnos reales, no solamente `manual-question`;
- `latest actionable turn` cambiando entre preguntas;
- `compactionApplied` cuando el contexto crece;
- la última pregunta permaneciendo incluida después de compactar;
- diversidad de respuestas y ausencia de respuesta repetida sin relación;
- overlay mostrando el mismo orden que el transcript del contexto.

## Resultado de la ejecución corregida

Log de referencia:

`C:\Users\Asus\AppData\Roaming\callpilot-v0\reports\sessions\session-2026-08-06T10-53-14-542Z-6b1521.metrics.json`

Observaciones:

- 136 transcripts integrados en la aplicación.
- 30 acciones manuales registradas.
- 29 generaciones Natively completadas antes de que expirara el timeout externo del controlador.
- cero errores de aplicación.
- `transcriptCharacterCount` llegó a `33526`.
- `includedTurnIds` llegó a 16 turnos recientes.
- `compactionApplied: true`.
- Las respuestas cambiaron según el tema: cron, tickets, secretos, backups, capacity planning y performance.

La sesión demostró que el contexto ya no estaba vacío y que la repetición genérica anterior quedó corregida. Para un resultado de release, se debe repetir con un controlador cuyo timeout sea superior a la duración total de 30 generaciones y exigir 30/30 completadas.

## Cierre y limpieza

Al finalizar:

```powershell
Get-Process electron,node -ErrorAction SilentlyContinue | Stop-Process -Force
```

No borrar reportes de sesión hasta terminar la auditoría. Los logs son necesarios para comparar contexto, tiempos, solapamientos y degradación.
