import { isNativeComposer } from "./attachments";

export interface SpeechCapture { stop(): Promise<string>; cancel(): void; }
interface RecognitionResultEvent { results: ArrayLike<ArrayLike<{ transcript: string }>>; }
interface BrowserRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

/** The microphone is opened only by a user gesture and never sends a message. */
export async function startSpeechCapture(onPartial: (text: string) => void): Promise<SpeechCapture> {
  if (isNativeComposer()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("pet_speech_start");
    return {
      stop: async () => (await invoke<{ text: string }>("pet_speech_stop")).text,
      cancel: () => { void invoke("pet_speech_cancel").catch(() => undefined); },
    };
  }
  const speechWindow = window as unknown as { SpeechRecognition?: new () => BrowserRecognition; webkitSpeechRecognition?: new () => BrowserRecognition };
  const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
  if (!Recognition) throw new Error("这个浏览器暂不支持语音输入。可以使用 macOS 桌面版，或继续打字。");
  const recognition = new Recognition();
  recognition.lang = "zh-CN";
  recognition.continuous = true;
  recognition.interimResults = true;
  let text = "";
  let ended = false;
  let failure: Error | undefined;
  let complete: ((value: string) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  recognition.onresult = (event) => {
    text = Array.from(event.results).map((result) => result[0]?.transcript ?? "").join("");
    onPartial(text);
  };
  await new Promise<void>((resolve, reject) => {
    recognition.onstart = resolve;
    recognition.onerror = (event) => {
      failure = new Error(event.error === "not-allowed" || event.error === "service-not-allowed"
        ? "麦克风或语音识别权限未开启。可以在系统设置中允许，或继续打字。"
        : "语音识别没有完成，请重试或继续打字。");
      reject(failure);
      fail?.(failure);
    };
    recognition.onend = () => { ended = true; if (failure) fail?.(failure); else complete?.(text); };
    recognition.start();
  });
  return {
    stop: () => new Promise<string>((resolve, reject) => {
      if (failure) { reject(failure); return; }
      if (ended) { resolve(text); return; }
      complete = resolve;
      fail = reject;
      recognition.stop();
    }),
    cancel: () => { recognition.abort(); },
  };
}
