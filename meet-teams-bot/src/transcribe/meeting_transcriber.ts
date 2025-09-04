// src/transcribe/meeting_transcriber.ts
// Thin wrapper around the existing AudioTranscriber implementation
// Event names mirror ScreenRecorder: "segment", "progress", "done", "error"
//
// NOTE: Keep logic identical to your current meeting_transcriber version; this file only standardizes the shape/exports

import fs from "fs";
import path from "path";
import os from "os";
import { EventEmitter } from "events";
import crypto from "crypto";
import 'dotenv/config';
import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { spawn } from "child_process";


export type Range = [number, number];

export interface TranscribedItem {
  speaker: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  engine: string;
  transcript: string;
}

export interface AudioTranscriberStartArgs {
  media: string;
  log: string;
  out?: string;
}

export interface AudioTranscriberOptions {
  engine?: 'azure';
  preprocess?: boolean;
  loudnormI?: number;
  loudnormTP?: number;
  loudnormLRA?: number;
}

const SPEECH_KEY = process.env.SPEECH_KEY || "";
const SPEECH_REGION = process.env.SPEECH_REGION || "";

type AzureTranscribeOpts = {
  mode?: "single" | "auto";                 // "single" = บังคับภาษาเดียว, "auto" = ตรวจจับหลายภาษา
  languages?: string[];                      // ใช้เมื่อ mode = "auto"
  initialSilenceMs?: number;                 // เวลารอเงียบตอนเริ่ม
  endSilenceMs?: number;                     // เวลารอเงียบตอนจบ
};

function replaceExt(p: string, suffix: string) {
  const dir = path.dirname(p);
  const base = path.basename(p, path.extname(p));
  return path.join(dir, `${base}${suffix}`);
}

function execFFmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const bin = process.env.FFMPEG_BIN || 'ffmpeg';
    const proc = spawn(bin, args);
    let stderr = "";
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (code ${code})\n${stderr}`));
    });
  });
}

async function loudnormForSpeech(inputPath: string, outputPath?: string, opts: { I?: number; TP?: number; LRA?: number; ar?: number; ac?: number } = {}): Promise<string> {
  const { I = -16.0, TP = -1.5, LRA = 11.0, ar = 16000, ac = 1 } = opts;
  const out = outputPath || replaceExt(inputPath, `_loudnorm.wav`);
  await execFFmpeg([
    '-y', '-i', inputPath,
    '-af', `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}`,
    '-ar', String(ar), '-ac', String(ac), '-c:a', 'pcm_s16le', out
  ]);
  if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error('ffmpeg ended without creating a valid output file.');
  return out;
}

async function probeDurationSec(inputPath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(process.env.FFMPEG_BIN || 'ffmpeg', ['-i', inputPath]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', () => {
      const m = stderr.match(/Duration: (\d\d):(\d\d):(\d\d)\.(\d\d)/);
      if (!m) return resolve(0);
      const h = +m[1], mi = +m[2], s = +m[3], cs = +m[4];
      resolve(h * 3600 + mi * 60 + s + cs / 100);
    });
  });
}

async function mediaDurationMs(inputPath: string): Promise<number> { return Math.round((await probeDurationSec(inputPath)) * 1000); }

async function cutWav16kMono(srcPath: string, [st, ed]: Range): Promise<string> {
  const out = path.join(os.tmpdir(), `seg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.wav`);
  await execFFmpeg(['-y', '-i', srcPath, '-ss', (st/1000).toFixed(3), '-to', (ed/1000).toFixed(3), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out]);
  return out;
}

async function transcribeWavAzure(wavPath: string): Promise<string> {
  if (!SPEECH_KEY || !SPEECH_REGION) throw new Error("❌ SPEECH_KEY / SPEECH_REGION ไม่ถูกตั้งค่า");
  const speechConfig = sdk.SpeechConfig.fromSubscription(SPEECH_KEY, SPEECH_REGION);
  // IMPORTANT: keep your original style — using fromWavFileInput with Buffer
  const audioConfig = sdk.AudioConfig.fromWavFileInput(fs.readFileSync(wavPath));
  const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
  const collected: string[] = [];
  return new Promise<string>((resolve) => {
    recognizer.recognized = (_s, e) => { const t = e?.result?.text; if (t) collected.push(t); };
    recognizer.canceled = () => { resolve(collected.join(' ').trim()); recognizer.close(); };
    recognizer.sessionStopped = () => { resolve(collected.join(' ').trim()); recognizer.close(); };
    recognizer.startContinuousRecognitionAsync();
  });
}

export async function transcribeWavAzure_v2(
  wavPath: string,
  opts: AzureTranscribeOpts = {}
): Promise<string> {
  if (!SPEECH_KEY || !SPEECH_REGION) {
    throw new Error("❌ SPEECH_KEY / SPEECH_REGION ไม่ถูกตั้งค่า");
  }

  const {
    mode = "single",
    languages = ["th-TH", "en-US"], // เผื่อใช้ auto
    initialSilenceMs = 8000,
    endSilenceMs = 2000,
  } = opts;

  const speechConfig = sdk.SpeechConfig.fromSubscription(SPEECH_KEY, SPEECH_REGION);

  // ตั้งค่า silence timeouts เหมือนใน v1
  speechConfig.setProperty(
    sdk.PropertyId[sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs],
    String(initialSilenceMs)
  );
  speechConfig.setProperty(
    sdk.PropertyId[sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs],
    String(endSilenceMs)
  );

  // ✅ บังคับภาษาไทยแบบ v1 (กรณี single)
  if (mode === "single") {
    speechConfig.speechRecognitionLanguage = "th-TH";
  } else {
    // โหมดตรวจจับหลายภาษาแบบต่อเนื่อง
    speechConfig.setProperty(
      sdk.PropertyId[sdk.PropertyId.SpeechServiceConnection_LanguageIdMode],
      "Continuous"
    );
  }

  const audioConfig = sdk.AudioConfig.fromWavFileInput(fs.readFileSync(wavPath));

  // เลือกสร้าง recognizer ตามโหมด
  let recognizer: sdk.SpeechRecognizer;
  if (mode === "auto") {
    const autoLang = sdk.AutoDetectSourceLanguageConfig.fromLanguages(languages);
    recognizer = sdk.SpeechRecognizer.FromConfig(speechConfig, autoLang, audioConfig);
  } else {
    recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
  }

  const collected: string[] = [];

  return new Promise<string>((resolve) => {
    // เก็บผลลัพธ์ที่ “recognized” เท่านั้น (finalized)
    recognizer.recognized = (_s, e) => {
      const t = e?.result?.text;
      if (t) collected.push(t);
    };

    // ปิดงานแบบ best-effort
    const finish = () => {
      try { recognizer.stopContinuousRecognitionAsync(); } catch {}
      try { recognizer.close(); } catch {}
      resolve(collected.join(" ").trim());
    };

    recognizer.canceled = finish;
    recognizer.sessionStopped = finish;

    recognizer.startContinuousRecognitionAsync();
  });
}

// NOTE: We assume you already computed speaker ranges from your meeting log externally (same as your Python version)
export type EventsNorm = [number, Set<string>][];
export function buildPerSpeakerSegmentsFromEvents(eventsNorm: EventsNorm, mediaDurationMs?: number) {
  const segments: Record<string, Range[]> = {};
  const openStart: Record<string, number> = {};
  let prev = new Set<string>();
  const ensure = (sp: string) => { if (!segments[sp]) segments[sp] = []; };
  for (const [ts, active] of eventsNorm) {
    for (const sp of Array.from(prev)) {
      if (!active.has(sp) && openStart[sp] !== undefined) {
        ensure(sp); segments[sp].push([openStart[sp], ts]); delete openStart[sp];
      }
    }
    for (const sp of Array.from(active)) {
      if (!prev.has(sp) && openStart[sp] === undefined) openStart[sp] = ts;
    }
    prev = new Set(active);
  }
  if (mediaDurationMs !== undefined) {
    for (const [sp, st] of Object.entries(openStart)) {
      segments[sp] = segments[sp] || []; segments[sp].push([st, mediaDurationMs]);
    }
  }
  return segments;
}

export class AudioTranscriber extends EventEmitter {
  private running = false;
  constructor(private opts: AudioTranscriberOptions = {}) { super(); }

  stop() { this.running = false; }

  async start(args: AudioTranscriberStartArgs): Promise<TranscribedItem[]> {
    const { media, log, out = 'transcripts_by_speaker.json' } = args;
    if (this.running) throw new Error('AudioTranscriber is already running');
    this.running = true;
    try {
      // Load event log produced by your Teams bot (JSON lines), normalized to eventsNorm
      const eventsNorm = await loadEventsWithBaseTs(log);
      const durMs = await mediaDurationMs(media);
      const bySpk = buildPerSpeakerSegmentsFromEvents(eventsNorm, durMs);
      const results: TranscribedItem[] = [];
      let total = Object.values(bySpk).reduce((n, a) => n + a.length, 0), idx = 0;

      for (const [spk, ranges] of Object.entries(bySpk)) {
        for (const [st, ed] of ranges) {
          if (!this.running) throw new Error('stopped');
          const raw = await cutWav16kMono(media, [st, ed]);
          try {
            let src = raw;
            const { preprocess = true, loudnormI = -16.0, loudnormTP = -1.5, loudnormLRA = 11.0 } = this.opts;
            if (preprocess) src = await loudnormForSpeech(raw, undefined, { I: loudnormI, TP: loudnormTP, LRA: loudnormLRA, ar: 16000, ac: 1 });
            const text = await transcribeWavAzure_v2(src);
            const item: TranscribedItem = { speaker: spk, start_ms: st, end_ms: ed, duration_ms: ed - st, engine: 'azure', transcript: text };
            results.push(item);
            this.emit('segment', item);
          } catch (e) {
            this.emit('error', e);
          } finally {
            idx += 1; this.emit('progress', { speaker: spk, index: idx, total });
            try { fs.existsSync(raw) && fs.unlinkSync(raw); } catch {}
          }
        }
      }

      results.sort((a, b) => a.start_ms - b.start_ms);
      fs.writeFileSync(out, JSON.stringify(results, null, 2), 'utf8');
      this.emit('done', results);
      return results;
    } finally {
      this.running = false;
    }
  }
}

export function createAudioTranscriber(opts: AudioTranscriberOptions = {}) { return new AudioTranscriber(opts); }

// ---- helpers to read your event log (same shape as your Python demo) ----
async function loadEventsWithBaseTs(logPath: string): Promise<EventsNorm> {
  const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
  type One = { timestamp: number; name: string; isSpeaking?: boolean };
  const events: [number, Set<string>][] = [];
  for (const line of lines) {
    const data = JSON.parse(line) as any;
    if (Array.isArray(data)) {
      if (!data.length) continue; const ts = Number(data[0].timestamp);
      const active = new Set<string>(data.filter((e: One) => e?.isSpeaking).map((e: One) => String(e.name)));
      events.push([ts, active]);
    } else if (data && typeof data === 'object') {
      const ts = Number((data as One).timestamp);
      const active = (data as One).isSpeaking ? new Set<string>([String((data as One).name)]) : new Set<string>();
      events.push([ts, active]);
    }
  }
  if (!events.length) throw new Error('log ว่างหรืออ่านไม่ได้');
  events.sort((a, b) => a[0] - b[0]);
  const base = events[0][0];
  return events.map(([ts, active]) => [ts - base, active]);
}
