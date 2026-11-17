const WORKLET_SOURCE = `
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSamples = 1920 * 2;
    this.ring = new Int16Array(this.targetSamples + 256);
    this.write = 0;
    this.emit = false;
    this.port.onmessage = (event) => {
      this.emit = event.data === "emit";
      if (!this.emit) this.write = 0;
    };
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || !channels[0]) return true;
    if (!this.emit) return true;

    const left = channels[0];
    const right = channels[1] || channels[0];
    for (let i = 0; i < left.length; i++) {
      const l = Math.max(-1, Math.min(1, left[i]));
      const r = Math.max(-1, Math.min(1, right[i] || 0));
      this.ring[this.write++] = l < 0 ? l * 0x8000 : l * 0x7fff;
      this.ring[this.write++] = r < 0 ? r * 0x8000 : r * 0x7fff;
      if (this.write >= this.targetSamples) {
        const chunk = this.ring.slice(0, this.targetSamples);
        const extra = this.write - this.targetSamples;
        if (extra > 0) this.ring.copyWithin(0, this.targetSamples, this.write);
        this.write = extra;
        this.port.postMessage(chunk, [chunk.buffer]);
      }
    }
    return true;
  }
}

registerProcessor("ytmd-pcm", PcmProcessor);
`;

declare global {
  interface Window {
    discordVoice?: {
      sendPcm(bytes: Uint8Array): void;
      reportError(message: string): void;
      reportStarted(): void;
      onRecapture(callback: () => void): void;
      onSetActive(callback: (active: boolean) => void): void;
      onSetOutput(callback: (emit: boolean) => void): void;
    };
  }
}

let runId = 0;
let audioContext: AudioContext | null = null;
let currentStream: MediaStream | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let workletNode: AudioWorkletNode | null = null;
let sink: GainNode | null = null;
let emitPcm = false;

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resampleStereo(interleaved: Int16Array, fromRate: number): Int16Array {
  if (fromRate === 48000) return interleaved;
  const frames = interleaved.length / 2;
  const outFrames = Math.max(1, Math.floor((frames * 48000) / fromRate));
  const out = new Int16Array(outFrames * 2);
  for (let i = 0; i < outFrames; i++) {
    const src = (i * fromRate) / 48000;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, frames - 1);
    const t = src - i0;
    for (let channel = 0; channel < 2; channel++) {
      const a = interleaved[i0 * 2 + channel];
      const b = interleaved[i1 * 2 + channel];
      out[i * 2 + channel] = a + (b - a) * t;
    }
  }
  return out;
}

function stopGraph() {
  currentStream?.getTracks().forEach(track => track.stop());
  currentStream = null;
  source?.disconnect();
  workletNode?.port.close();
  workletNode?.disconnect();
  sink?.disconnect();
  source = null;
  workletNode = null;
  sink = null;
}

async function closeContext() {
  stopGraph();
  const context = audioContext;
  audioContext = null;
  if (!context) return;
  try {
    await context.close();
  } catch {
    // The context is already closed.
  }
}

const musicAudioConstraints: MediaTrackConstraints = {
  // Bare `audio: true` lets Chromium run echo cancellation, noise suppression, and
  // auto gain. Those are for microphones and make music sound like a phone call.
  echoCancellation: { ideal: false },
  noiseSuppression: { ideal: false },
  autoGainControl: { ideal: false },
  channelCount: { ideal: 2 },
  sampleRate: { ideal: 48000 },
  sampleSize: { ideal: 16 }
};

async function ensureContext() {
  if (!audioContext) {
    audioContext = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
    try {
      await audioContext.audioWorklet.addModule(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
  }
  if (audioContext.state === "suspended") await audioContext.resume();
  return audioContext;
}

function setWorkletEmit(emit: boolean) {
  emitPcm = emit;
  workletNode?.port.postMessage(emit ? "emit" : "drop");
}

async function captureOnce(id: number) {
  const bridge = window.discordVoice;
  if (!bridge) return;
  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: musicAudioConstraints,
    video: {
      frameRate: 1,
      width: 16,
      height: 16
    }
  });
  if (id !== runId) {
    stream.getTracks().forEach(track => track.stop());
    return;
  }

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stream.getTracks().forEach(track => track.stop());
    throw new Error("YouTube Music audio capture did not start.");
  }

  const audioTrack = audioTracks[0];
  audioTrack.contentHint = "music";
  try {
    await audioTrack.applyConstraints(musicAudioConstraints);
  } catch {
    // Some capture paths reject a constraint they cannot change. The request above still asked for clean audio.
  }

  // getDisplayMedia requires a video track. Drop it so only audio is processed.
  for (const track of stream.getVideoTracks()) {
    track.stop();
    stream.removeTrack(track);
  }

  const context = await ensureContext();
  if (id !== runId) {
    stream.getTracks().forEach(track => track.stop());
    return;
  }

  currentStream = stream;
  source = context.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(context, "ytmd-pcm");
  sink = context.createGain();
  sink.gain.value = 0;
  source.connect(workletNode);
  workletNode.connect(sink);
  sink.connect(context.destination);
  setWorkletEmit(emitPcm);

  workletNode.port.onmessage = (event: MessageEvent<Int16Array>) => {
    if (id !== runId || !emitPcm || !(event.data instanceof Int16Array)) return;
    const pcm = resampleStereo(event.data, context.sampleRate);
    window.discordVoice?.sendPcm(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  };

  bridge.reportStarted();

  await new Promise<void>(resolve => {
    audioTracks[0].addEventListener("ended", () => resolve(), { once: true });
  });
}

async function start() {
  const id = ++runId;
  stopGraph();
  while (id === runId) {
    try {
      await captureOnce(id);
      if (id !== runId) return;
      stopGraph();
    } catch (error) {
      if (id !== runId) return;
      stopGraph();
      const message = error instanceof Error ? error.message : "Could not capture YouTube Music audio.";
      window.discordVoice?.reportError(message);
      await delay(2000);
    }
  }
}

function stop() {
  runId++;
  void closeContext();
}

export function attachDiscordCapture() {
  const bridge = window.discordVoice;
  if (!bridge?.onSetActive) return;
  bridge.onSetOutput(emit => setWorkletEmit(emit));
  bridge.onRecapture(() => {
    void start();
  });
  bridge.onSetActive(active => {
    if (active) void start();
    else stop();
  });
}
