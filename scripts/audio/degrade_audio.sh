#!/usr/bin/env bash
# degrade_audio.sh - simula condiciones reales de captura de entrevista sobre un audio limpio.
#
# Uso:
#   ./degrade_audio.sh input.wav output.wav <profile>
#
# Profiles disponibles (mic real + codec real de videollamada):
#   laptop_mic_zoom     -> mic de notebook + ruido leve + Opus 24k
#   headset_meet        -> mic de headset + Opus 32k, casi sin ruido de fondo
#   phone_speaker_teams -> altavoz de telefono recogido por mic externo + eco leve + Opus 16k
#   noisy_cafe          -> mic de notebook + ruido ambiente fuerte + Opus 24k
#
# El TTS da contenido y timing exacto para bugs de frontera/corte. Esta pipeline agrega
# respuesta de microfono, ruido de fondo y compresion con perdida del codec de videollamada.

set -euo pipefail
IN="$1"
OUT="$2"
PROFILE="${3:-laptop_mic_zoom}"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

ffmpeg -y -i "$IN" -ar 16000 -ac 1 "$TMP/base.wav" -loglevel error

case "$PROFILE" in
  laptop_mic_zoom)
    NOISE_COLOR="pink"; NOISE_AMP="0.02"; HP=120; LP=7500; EQ_FREQ=2500; EQ_GAIN=3
    OPUS_BITRATE="24k"; ECHO=""
    ;;
  headset_meet)
    NOISE_COLOR="white"; NOISE_AMP="0.005"; HP=60; LP=9000; EQ_FREQ=3000; EQ_GAIN=1
    OPUS_BITRATE="32k"; ECHO=""
    ;;
  phone_speaker_teams)
    NOISE_COLOR="pink"; NOISE_AMP="0.03"; HP=200; LP=6000; EQ_FREQ=1500; EQ_GAIN=5
    OPUS_BITRATE="16k"; ECHO="aecho=0.6:0.5:60:0.25,"
    ;;
  noisy_cafe)
    NOISE_COLOR="brown"; NOISE_AMP="0.06"; HP=120; LP=7500; EQ_FREQ=2500; EQ_GAIN=3
    OPUS_BITRATE="24k"; ECHO=""
    ;;
  *)
    echo "Profile desconocido: $PROFILE" >&2; exit 1
    ;;
esac

ffmpeg -y -i "$TMP/base.wav" -f lavfi -i "anoisesrc=color=${NOISE_COLOR}:sample_rate=16000:amplitude=${NOISE_AMP}" \
  -filter_complex "[0:a]${ECHO}highpass=f=${HP},lowpass=f=${LP},equalizer=f=${EQ_FREQ}:t=q:w=1:g=${EQ_GAIN}[voice]; \
                   [voice][1:a]amix=inputs=2:duration=first:weights=1 0.35[mixed]" \
  -map "[mixed]" -ar 16000 -ac 1 "$TMP/pre_codec.wav" -loglevel error

ffmpeg -y -i "$TMP/pre_codec.wav" -c:a libopus -b:a "$OPUS_BITRATE" "$TMP/compressed.opus" -loglevel error
ffmpeg -y -i "$TMP/compressed.opus" -ar 16000 -ac 1 "$OUT" -loglevel error

echo "OK: $OUT (profile: $PROFILE)"
