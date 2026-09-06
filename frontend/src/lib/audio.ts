import { API_BASE } from './api';

const TARGET_RATE = 16_000;

export interface CaptureHandle {
  stop: () => void;
  /** Stop the mic and ask the backend to finish; resolves with its final export. */
  finish: (timeoutMs?: number) => Promise<any>;
  socket: WebSocket;
  analyser: AnalyserNode;
  audioCtx: AudioContext;
}

/** Downsample a Float32 block from `inRate` to 16 kHz with anti-aliased box filtering. */
function downsample(block: Float32Array, inRate: number): Float32Array {
  if (inRate === TARGET_RATE) return block;
  const ratio = inRate / TARGET_RATE;
  const outLen = Math.floor(block.length / ratio);
  const out = new Float32Array(outLen);
  const filterSize = Math.max(1, Math.floor(ratio));

  for (let i = 0; i < outLen; i += 1) {
    const center = i * ratio;
    let sum = 0;
    let count = 0;
    const start = Math.max(0, Math.floor(center - filterSize / 2));
    const end = Math.min(block.length, Math.ceil(center + filterSize / 2));
    for (let j = start; j < end; j += 1) {
      sum += block[j]!;
      count += 1;
    }
    out[i] = count > 0 ? sum / count : block[Math.floor(center)] || 0;
  }
  return out;
}

function toInt16(f32: Float32Array): ArrayBuffer {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

export async function startCapture(opts: {
  sessionId: string;
  transcriptSource: 'browser' | 'server';
  onMessage: (msg: any) => void;
  onClose?: () => void;
}): Promise<CaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });

  const wsBase = API_BASE.replace(/^http/, 'ws');
  const socket = new WebSocket(`${wsBase}/ws?sessionId=${opts.sessionId}`);
  socket.binaryType = 'arraybuffer';

  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error('websocket failed'));
  });
  socket.send(JSON.stringify({ type: 'hello', transcriptSource: opts.transcriptSource }));
  socket.onmessage = (ev) => {
    try {
      opts.onMessage(JSON.parse(ev.data));
    } catch {
      /* ignore non-JSON */
    }
  };
  socket.onclose = () => opts.onClose?.();

  const audioCtx = new AudioContext();
  await audioCtx.audioWorklet.addModule('/capture-worklet.js');
  const src = audioCtx.createMediaStreamSource(stream);

  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.8;
  src.connect(analyser);

  const worklet = new AudioWorkletNode(audioCtx, 'capture-processor');
  src.connect(worklet);
  worklet.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const ds = downsample(ev.data, audioCtx.sampleRate);
    socket.send(toInt16(ds));
  };

  const stopMic = () => {
    worklet.port.onmessage = null;
    worklet.disconnect();
    analyser.disconnect();
    src.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    audioCtx.close().catch(() => {});
  };

  const stop = () => {
    try {
      socket.send(JSON.stringify({ type: 'end' }));
    } catch {
      /* noop */
    }
    stopMic();
    socket.close();
  };

  // Stop capturing but keep the socket open long enough for the backend to
  // transcribe the trailing audio, then return its final export.
  const finish = (timeoutMs = 8000): Promise<any> =>
    new Promise((resolve) => {
      stopMic();
      let done = false;
      const finishUp = (value: any) => {
        if (done) return;
        done = true;
        socket.onmessage = null;
        try {
          socket.close();
        } catch {
          /* noop */
        }
        resolve(value);
      };
      const prev = socket.onmessage;
      socket.onmessage = (ev) => {
        if (typeof prev === 'function') prev.call(socket, ev);
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'ended') finishUp(msg.export ?? null);
        } catch {
          /* ignore */
        }
      };
      try {
        socket.send(JSON.stringify({ type: 'end' }));
      } catch {
        finishUp(null);
      }
      setTimeout(() => finishUp(null), timeoutMs);
    });

  return { stop, finish, socket, analyser, audioCtx };
}
