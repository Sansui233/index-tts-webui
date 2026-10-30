export interface Named {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}
export interface Audio extends Named {
  path: string;
  size: number;
  /* "samples": a file in samples/ referenced in place; path is relative to samples/. */
  source?: "samples";
}
export interface Role extends Named {
  tags: string[];
  /* Narrator, passers-by: may use any audio. */
  anonymous: boolean;
  /* The audio currently in samples/<name>/, read on each request; not stored. */
  audio_ids: string[];
}
export interface Binding {
  speaker: string;
  role_id: string | null;
  audio_id: string | null;
}
export interface Generation {
  mode: "normal" | "fast";
  do_sample: boolean;
  top_p: number;
  top_k: number;
  temperature: number;
  length_penalty: number;
  num_beams: number;
  repetition_penalty: number;
  max_mel_tokens: number;
  max_text_tokens_per_sentence: number;
  sentences_bucket_max_size: number;
}
export const defaultGeneration: Generation = {
  mode: "normal",
  do_sample: true,
  top_p: 0.8,
  top_k: 30,
  temperature: 1,
  length_penalty: 0,
  num_beams: 3,
  repetition_penalty: 10,
  max_mel_tokens: 600,
  max_text_tokens_per_sentence: 120,
  sentences_bucket_max_size: 4,
};
/* A take's audio has no record; its file is derived from session, line and take. */
export interface Take {
  id: string;
  take_index: number;
  created_at: string;
  snapshot: { text: string; speaker: string; audio_id: string | null; generation: Generation };
}
export interface Line {
  id: string;
  index: number;
  text: string;
  speaker: string;
  takes: Take[];
  current_take_id: string | null;
}
export interface Preset extends Named {
  bindings: Binding[];
  generation: Generation;
}
export interface Session extends Preset {
  project_id: string | null; // null: not in any project
  interval: number;
  lines: Line[];
  outputs: string[];
  line_count?: number;
}
/* A saved voice of an API: a name callers pass as `voice`, bound to reference audio. */
export interface Voice {
  name: string;
  audio_id: string;
}
/* External TTS endpoint at /tts/<slug>. Public: GET/POST, no auth. Private: POST + bearer token. */
export interface ApiEndpoint extends Named {
  slug: string;
  access: "public" | "private";
  enabled: boolean;
  /* Set once the API has been private; kept across switches so clients can resume. */
  token: string | null;
  voices: Voice[];
  generation: Generation;
}
export interface Task extends Named {
  kind: string;
  title: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  progress: number;
  message: string;
  error: string | null;
  result: Audio | { session_id: string } | null;
  session_ids: string[];
  line_ids?: string[];
  started_at?: string;
  finished_at?: string;
}
export interface Cleanup {
  deleted: number;
  bytes: number;
  failures: unknown[];
}

async function send(method: string, path: string, data?: unknown) {
  const form = data instanceof FormData;
  const response = await fetch("/api" + path, {
    method,
    headers: data === undefined || form ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : form ? data : JSON.stringify(data),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail));
  }
  return response;
}

async function request<T>(method: string, path: string, data?: unknown): Promise<T> {
  return (await send(method, path, data)).json();
}

/* POST that answers with a file (e.g. a zip); saves it as `filename`. */
export async function download(path: string, data: unknown, filename: string) {
  const url = URL.createObjectURL(await (await send("POST", path, data)).blob());
  Object.assign(document.createElement("a"), { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, data?: unknown) => request<T>("POST", path, data),
  put: <T>(path: string, data?: unknown) => request<T>("PUT", path, data),
  patch: <T>(path: string, data?: unknown) => request<T>("PATCH", path, data),
  del: <T>(path: string) => request<T>("DELETE", path),
};

export const takeUrl = (sessionId: string, lineId: string, take: Take) => `/api/sessions/${sessionId}/lines/${lineId}/takes/${take.id}/file`;
export const fileUrl = (id: string, download = false) =>
  `/api/audio/${id}/file${download ? "?download=true" : ""}`;

export function upload(file: File) {
  const data = new FormData();
  data.append("file", file);
  return api.post<Audio>("/audio/upload", data);
}

export const isActive = (t: Task) => t.status === "queued" || t.status === "running";
export const isAudio = (a: Audio) => !a.path.endsWith(".srt");

/* Where an audio record comes from. Files from disk (samples, uploads) are named by their
   file name; generated audio only has a display name (the file on disk is an id). */
export type AudioKind = "sample" | "upload" | "speech" | "subtitle" | "merge";
export function audioKind(a: Audio): AudioKind {
  if (a.source === "samples") return "sample";
  if (a.path.startsWith("audio/files/")) return "upload";
  if (a.path.includes("/merged/")) return "merge";
  return a.path.endsWith(".srt") ? "subtitle" : "speech";
}
export const GENERATED: Partial<Record<AudioKind, string>> = { speech: "语音生成", subtitle: "字幕", merge: "合并" };
export const currentTake = (l: Line) => l.takes.find((t) => t.id === l.current_take_id);
export const resultAudio = (t: Task) => (t.result && "path" in t.result ? t.result : null);
export const taskTitle = (t: Task) => t.title || resultAudio(t)?.name || "";
