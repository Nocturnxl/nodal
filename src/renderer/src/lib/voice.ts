import { takeSentences } from '@shared/speech';
import type { SpokenAudio } from '@shared/types';

// One voice conversation: listen until the speaker pauses, turn the recording
// into text, send it as an ordinary message, read the reply aloud as it
// arrives, then listen again. The microphone is only recorded while listening,
// so the app never hears its own voice.

/** `silent` is listening to a microphone that delivers nothing at all: muted, or blocked by the operating system. */
export type VoicePhase = 'starting' | 'listening' | 'silent' | 'hearing' | 'transcribing' | 'thinking' | 'speaking';

/** A reply as it streams. `listen` calls back with the whole text so far, and once more with `done` when it is complete. */
export interface ReplyFeed {
  listen(cb: (text: string, done: boolean) => void): () => void;
}

export interface VoiceHost {
  onPhase(phase: VoicePhase): void;
  /** Something went wrong that ends the session. The session has already released the microphone. */
  onError(e: unknown): void;
  transcribe(mime: string, data: Uint8Array): Promise<string>;
  speak(text: string): Promise<SpokenAudio>;
  /** Sends the words as a chat message. Null when it could not be sent. */
  send(text: string): Promise<ReplyFeed | null>;
}

const TICK_MS = 50;
/** Sound this long counts as speech rather than a click or a cough. */
const SPEECH_MS = 250;
/** A pause this long after speech ends the turn. */
const PAUSE_MS = 1100;
/** With nothing said, the recording is thrown away and restarted this often so it stays small. */
const IDLE_RESTART_MS = 20_000;
/** A single turn is cut off here, well inside the provider's upload limit. */
const MAX_TURN_MS = 120_000;
const MIN_LEVEL = 0.015;
/** A working microphone always carries some noise. Exact silence for this long means it is muted or blocked. */
const DEAD_MS = 4000;

function micError(e: unknown): Error {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new Error('No microphone was found. Plug one in and try again.');
  if (name === 'NotAllowedError' || name === 'SecurityError') return new Error("NODAL was not allowed to use the microphone. Allow it in your system's privacy settings and try again.");
  if (name === 'NotReadableError') return new Error('The microphone is in use by another program or could not be started.');
  return e instanceof Error ? e : new Error(String(e));
}

export class VoiceSession {
  private stream: MediaStream | null = null;
  private audio: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private playing: AudioBufferSourceNode | null = null;
  private unlisten: (() => void) | null = null;
  private phase: VoicePhase = 'starting';
  private stopped = false;
  /** Whether the microphone has delivered any signal at all this session. */
  private alive = false;
  /** Goes up whenever the session moves on, so work started earlier can tell it is out of date. */
  private turn = 0;

  constructor(private readonly host: VoiceHost) {}

  async start(): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      throw micError(e);
    }
    if (this.stopped) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;
    this.audio = new AudioContext();
    this.analyser = this.audio.createAnalyser();
    this.analyser.fftSize = 1024;
    this.audio.createMediaStreamSource(stream).connect(this.analyser);
    this.listen();
  }

  /** Ends the turn now instead of waiting for a pause. */
  sendNow(): void {
    if (this.phase === 'listening' || this.phase === 'hearing' || this.phase === 'silent') void this.finish();
  }

  /** Stops reading the reply aloud and listens again. */
  skip(): void {
    if (this.phase !== 'speaking' && this.phase !== 'thinking') return;
    this.silence();
    this.listen();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.turn++;
    clearInterval(this.timer);
    this.silence();
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    } catch {
      /* already stopped */
    }
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    void this.audio?.close().catch(() => {});
  }

  private setPhase(phase: VoicePhase): void {
    if (this.stopped || this.phase === phase) return;
    this.phase = phase;
    this.host.onPhase(phase);
  }

  private fail(e: unknown): void {
    if (this.stopped) return;
    this.stop();
    this.host.onError(e);
  }

  private silence(): void {
    this.unlisten?.();
    this.unlisten = null;
    try {
      this.playing?.stop();
    } catch {
      /* not started */
    }
    this.playing = null;
  }

  private listen(): void {
    if (this.stopped || !this.stream || !this.analyser) return;
    const analyser = this.analyser;
    this.turn++;
    clearInterval(this.timer);
    try {
      if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.onstop = null;
        this.recorder.stop();
      }
    } catch {
      /* already stopped */
    }
    const chunks: Blob[] = [];
    this.chunks = chunks;
    const type = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined;
    const recorder = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined);
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.start();
    this.recorder = recorder;
    this.phase = 'starting'; // so the next line always reports
    this.setPhase('listening');

    const samples = new Float32Array(analyser.fftSize);
    const startedAt = performance.now();
    let last = startedAt;
    let spoken = 0;
    let quiet = 0;
    let floor = 0.005; // the room's own noise, learned while nobody speaks
    this.timer = setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      const level = Math.sqrt(sum / samples.length);
      if (level > 0) {
        this.alive = true;
        if (this.phase === 'silent') this.setPhase('listening');
      } else if (!this.alive && now - startedAt > DEAD_MS && this.phase === 'listening') {
        this.setPhase('silent');
      }
      if (level > Math.max(MIN_LEVEL, floor * 3)) {
        spoken += dt;
        quiet = 0;
        if (spoken >= SPEECH_MS) this.setPhase('hearing');
      } else {
        quiet += dt;
        floor = floor * 0.95 + level * 0.05;
        if (spoken < SPEECH_MS && quiet > 400) spoken = 0;
      }
      if (spoken >= SPEECH_MS && (quiet >= PAUSE_MS || now - startedAt > MAX_TURN_MS)) void this.finish();
      else if (spoken < SPEECH_MS && now - startedAt > IDLE_RESTART_MS) this.listen();
    }, TICK_MS);
  }

  private async finish(): Promise<void> {
    const recorder = this.recorder;
    if (this.stopped || !recorder || recorder.state === 'inactive') return;
    clearInterval(this.timer);
    const turn = this.turn;
    const stale = () => this.stopped || turn !== this.turn;
    const chunks = this.chunks;
    this.setPhase('transcribing');
    try {
      const blob = await new Promise<Blob>((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
        recorder.stop();
      });
      if (stale()) return;
      if (!blob.size) return this.listen();
      const text = await this.host.transcribe(blob.type, new Uint8Array(await blob.arrayBuffer()));
      if (stale()) return;
      if (!text.trim()) return this.listen();
      this.setPhase('thinking');
      const reply = await this.host.send(text.trim());
      if (stale()) return;
      if (!reply) return this.listen();
      this.read(reply, turn);
    } catch (e) {
      if (!stale()) this.fail(e);
    }
  }

  /** Reads the reply aloud sentence by sentence. Audio is requested as soon as a sentence is complete and played in order. */
  private read(reply: ReplyFeed, turn: number): void {
    const stale = () => this.stopped || turn !== this.turn;
    let seen = 0;
    let pending = '';
    let finished = false;
    let failure: unknown;
    let queue: Promise<void> = Promise.resolve();

    const enqueue = (piece: string) => {
      const audio = this.host.speak(piece);
      audio.catch(() => {}); // reported below, in order
      queue = queue.then(async () => {
        if (stale() || failure !== undefined) return;
        try {
          const clip = await audio;
          if (stale()) return;
          this.setPhase('speaking');
          await this.play(clip);
        } catch (e) {
          failure = e;
        }
      });
    };

    const off = reply.listen((text, done) => {
      if (stale() || finished) return;
      if (text.length > seen) {
        pending += text.slice(seen);
        seen = text.length;
      }
      const out = takeSentences(pending, done);
      pending = out.rest;
      out.pieces.forEach(enqueue);
      if (!done) return;
      finished = true;
      void queue.then(() => {
        if (stale()) return;
        if (failure !== undefined) this.fail(failure);
        else this.listen();
      });
    });
    if (finished) off();
    else this.unlisten = off;
  }

  private async play(clip: SpokenAudio): Promise<void> {
    const audio = this.audio;
    if (!audio) return;
    // decodeAudioData takes ownership of the buffer it is given, so hand it a copy.
    const bytes = clip.data.buffer.slice(clip.data.byteOffset, clip.data.byteOffset + clip.data.byteLength) as ArrayBuffer;
    const buffer = await audio.decodeAudioData(bytes);
    if (this.stopped) return;
    await new Promise<void>((resolve) => {
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.connect(audio.destination);
      source.onended = () => {
        if (this.playing === source) this.playing = null;
        resolve();
      };
      this.playing = source;
      source.start();
    });
  }
}
