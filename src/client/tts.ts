import type { PublicSettings } from '../shared/types.js';

/**
 * 朗读队列：浏览器 speechSynthesis 或云端 /audio/speech。
 * 队列策略：off=不读 / latest=只读最新（忙时丢弃） / limit=最多排队 N 条。
 */
export class TtsPlayer {
  private queue: string[] = [];
  private speaking = false;
  private audio: HTMLAudioElement | null = null;
  private canceled = false;

  constructor(private readonly getSettings: () => PublicSettings) {}

  stop(): void {
    this.canceled = true;
    this.queue = [];
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
    this.speaking = false;
  }

  /** 立即朗读一段文本（忽略自动朗读开关），供消息上的播放按钮使用。 */
  speakNow(text: string): void {
    const clean = sanitize(text);
    if (!clean) return;
    this.stop();
    this.queue = [clean];
    this.canceled = false;
    void this.pump();
  }

  speak(text: string): void {
    const s = this.getSettings();
    if (!s.ttsEnabled) return;
    const clean = sanitize(text);
    if (!clean) return;

    if (s.ttsQueueMode === 'off') {
      this.canceled = true;
      this.queue = [];
      this.queue.push(clean);
    } else if (s.ttsQueueMode === 'latest') {
      this.queue = [clean];
    } else {
      if (this.queue.length >= s.ttsQueueLimit) this.queue.shift();
      this.queue.push(clean);
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.speaking) return;
    const next = this.queue.shift();
    if (!next) return;
    this.speaking = true;
    this.canceled = false;
    try {
      if (this.getSettings().ttsEngine === 'Cloud') await this.speakCloud(next);
      else await this.speakBrowser(next);
    } catch {
      /* 朗读失败不影响主流程 */
    } finally {
      this.speaking = false;
      if (this.queue.length > 0) void this.pump();
    }
  }

  private speakBrowser(text: string): Promise<void> {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      if (!synth) {
        resolve();
        return;
      }
      const u = new SpeechSynthesisUtterance(text);
      const s = this.getSettings();
      u.lang = 'zh-CN';
      u.rate = Math.min(2, Math.max(0.5, 1 + s.ttsRate / 10));
      u.volume = s.ttsVolume;
      if (s.ttsVoice) {
        const voice = synth.getVoices().find((v) => v.name === s.ttsVoice);
        if (voice) u.voice = voice;
      }
      u.onend = () => resolve();
      u.onerror = () => resolve();
      synth.speak(u);
    });
  }

  private async speakCloud(text: string): Promise<void> {
    const resp = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) return;
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    await new Promise<void>((resolve) => {
      const audio = new Audio(url);
      this.audio = audio;
      audio.volume = this.getSettings().ttsVolume;
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      audio.play().catch(() => resolve());
    });
    URL.revokeObjectURL(url);
    this.audio = null;
  }
}

/** 去掉坐标、JSON、代码块等不适合朗读的内容。 */
export function sanitize(text: string): string {
  return (text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[\d+,\d+[^\]]*\]/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#*_>`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}
