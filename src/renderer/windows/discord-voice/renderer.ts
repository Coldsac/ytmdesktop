const WORKLET_SOURCE = `
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Int16Array(0);
    this.targetFrames = 1920;
  }

  append(samples) {
    const next = new Int16Array(this.pending.length + samples.length);
    next.set(this.pending, 0);
    next.set(samples, this.pending.length);
    this.pending = next;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || !channels[0]) return true;

    const left = channels[0];
    const right = channels[1] || channels[0];
    const pcm = new Int16Array(left.length * 2);
    for (let i = 0; i < left.length; i++) {
      const l = Math.max(-1, Math.min(1, left[i]));
      const r = Math.max(-1, Math.min(1, right[i] || 0));
      pcm[i * 2] = l < 0 ? l * 0x8000 : l * 0x7fff;
      pcm[i * 2 + 1] = r < 0 ? r * 0x8000 : r * 0x7fff;
    }
    this.append(pcm);

    const targetSamples = this.targetFrames * 2;
    if (this.pending.length >= targetSamples) {
      const chunk = this.pending.slice(0, targetSamples);
      this.pending = this.pending.slice(targetSamples);
      this.port.postMessage(chunk);
    }
    return true;
  }
}

registerProcessor("ytmd-pcm", PcmProcessor);
`;

declare global {
  interface Window {
    discordVoice: {
      sendPcm(bytes: Uint8Array): void;
      reportError(message: string): void;
      reportStarted(): void;
      onRecapture(callback: () => void): void;
    };
  }
}

let runId = 0;
let audioContext: AudioContext | null = null;
let currentStream: MediaStream | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let workletNode: AudioWorkletNode | null = null;
let sink: GainNode | null = null;

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
  workletNode?.disconnect();
  sink?.disconnect();
  source = null;
  workletNode = null;
  sink = null;
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
    audioContext = new AudioContext({ sampleRate: 48000, latencyHint: "playback" });
    const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
    await audioContext.audioWorklet.addModule(moduleUrl);
    URL.revokeObjectURL(moduleUrl);
  }
  if (audioContext.state === "suspended") await audioContext.resume();
  return audioContext;
}

async function captureOnce(id: number) {
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

  workletNode.port.onmessage = (event: MessageEvent<Int16Array>) => {
    if (id !== runId || !(event.data instanceof Int16Array)) return;
    const pcm = resampleStereo(event.data, context.sampleRate);
    window.discordVoice.sendPcm(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  };

  window.discordVoice.reportStarted();

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
      window.discordVoice.reportError(message);
      await delay(2000);
    }
  }
}

window.discordVoice.onRecapture(() => {
  void start();
});
void start();

export {};
