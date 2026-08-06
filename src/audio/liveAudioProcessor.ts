declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

declare const registerProcessor: (name: string, processor: new () => AudioWorkletProcessor) => void;

class CallPilotLiveAudioProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][], _outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (input?.length) this.port.postMessage(new Float32Array(input));
    return true;
  }
}

registerProcessor("callpilot-live-audio", CallPilotLiveAudioProcessor);
