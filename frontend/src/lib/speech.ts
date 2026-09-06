// Thin wrapper around the browser SpeechRecognition API. Used only when the
// session's transcript source is "browser" (the default, no API key needed).

type Handlers = { onResult: (text: string, isFinal: boolean) => void; onError?: (e: string) => void };

export function browserSpeechSupported(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

export function startBrowserSpeech(handlers: Handlers, lang?: string): () => void {
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!Ctor) {
    handlers.onError?.('This browser has no SpeechRecognition. Use Chrome, or enable server transcription.');
    return () => {};
  }
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = lang || (typeof navigator !== 'undefined' ? navigator.language : 'en-US') || 'en-US';

  let stopped = false;
  let restartTimeout: ReturnType<typeof setTimeout> | null = null;

  const safeStart = () => {
    if (stopped) return;
    try {
      rec.start();
    } catch {
      /* already starting or active */
    }
  };

  rec.onresult = (ev: any) => {
    let interim = '';
    let final = '';
    for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
      const chunk = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) final += chunk;
      else interim += chunk;
    }
    if (final) handlers.onResult(final.trim(), true);
    else if (interim) handlers.onResult(interim.trim(), false);
  };

  rec.onerror = (ev: any) => {
    const errorType = ev.error || 'speech error';
    // Ignore non-fatal benign errors like 'no-speech' or 'aborted'
    if (errorType !== 'no-speech' && errorType !== 'aborted') {
      handlers.onError?.(errorType);
    }
    if (!stopped && (errorType === 'network' || errorType === 'no-speech')) {
      if (restartTimeout) clearTimeout(restartTimeout);
      restartTimeout = setTimeout(safeStart, 500);
    }
  };

  rec.onend = () => {
    if (!stopped) {
      if (restartTimeout) clearTimeout(restartTimeout);
      restartTimeout = setTimeout(safeStart, 250);
    }
  };

  safeStart();

  return () => {
    stopped = true;
    if (restartTimeout) clearTimeout(restartTimeout);
    try {
      rec.stop();
    } catch {
      /* noop */
    }
  };
}
