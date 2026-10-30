import { useRef, useState } from "react";
import { ChevronDown, Plus, Sliders, Trash2, Upload } from "react-feather";
import { api, audioKind, GENERATED, isAudio, upload, type Audio, type Binding, type Generation, type Role } from "./api";
import { PlayButton, Player } from "./player";
import { useAction, useLoad } from "./state";
import { Combobox, cx, Field, Segmented, type Option } from "./ui";

type Source = { name: string; path: string };
const SAMPLE = "sample:";

/* Audio as combobox options: uploads, with `all` generated speech and merges (tagged by
   origin), then all of samples/ (referenced in place; resolve() registers one on first pick).
   Takes are left out: per-sentence clips, too many to list. */
export function useAudioOptions(all = false) {
  const audio = useLoad<Audio[]>(all ? "/audio" : "/audio?reference=true", []);
  const samples = useLoad<Source[]>("/audio/sources", []);
  const run = useAction();
  const registered = new Map(audio.data.filter((a) => a.source === "samples").map((a) => [a.path, a]));
  const sampled = new Set(samples.data.map((s) => s.path));
  const options: Option[] = [
    // Older imports copied samples files into uploads under the same name; samples lists them already.
    ...audio.data.filter((a) => audioKind(a) === "upload" && !sampled.has(a.name)).map((a) => ({ value: a.id, label: a.name, group: "上传" })),
    ...(all ? audio.data : [])
      .filter((a) => isAudio(a) && (audioKind(a) === "speech" || audioKind(a) === "merge"))
      .map((a) => ({ value: a.id, label: a.name, group: "生成的音频", tag: GENERATED[audioKind(a)] })),
    ...samples.data.map((s) => ({ value: registered.get(s.path)?.id ?? SAMPLE + s.path, label: s.name, group: "samples" })),
  ];
  const names = new Map(audio.data.map((a) => [a.id, a.name]));
  async function resolve(value: string) {
    if (!value.startsWith(SAMPLE)) return audio.data.find((a) => a.id === value);
    const created = await run(() => api.post<Audio>("/audio/import", { path: value.slice(SAMPLE.length) }));
    if (created) audio.setData((items) => [created, ...items]);
    return created;
  }
  const add = (record: Audio) => audio.setData((items) => [record, ...items]);
  return { options, names, resolve, add };
}

/* Reference audio: pick from uploads or samples/ (type to filter), or upload. */
export function AudioPicker({ value, onChange, all = false }: { value: string | null; onChange: (id: string, record?: Audio) => void; all?: boolean }) {
  const audio = useAudioOptions(all);
  const run = useAction();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function pick(load: () => Promise<Audio | undefined>) {
    setBusy(true);
    const record = await load();
    setBusy(false);
    if (record) onChange(record.id, record);
  }
  return (
    <div className="space-y-2">
      <div className="flex gap-1.5">
        <Combobox
          className="flex-1"
          label="参考音频"
          value={value}
          options={audio.options}
          disabled={busy}
          placeholder={busy ? "导入中…" : "选择参考音频，可输入筛选…"}
          onChange={(v) => void pick(() => audio.resolve(v))}
        />
        <button className="btn btn-icon" title="上传音频" aria-label="上传音频" disabled={busy} onClick={() => file.current?.click()}>
          <Upload size={14} />
        </button>
        <input
          ref={file}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f)
              void pick(async () => {
                const record = await run(() => upload(f));
                if (record) audio.add(record);
                return record;
              });
          }}
        />
      </div>
      {value && <Player id={value} />}
    </div>
  );
}

const NUMBERS: [keyof Generation, string, number][] = [
  ["temperature", "Temperature", 0.1],
  ["top_p", "Top P", 0.05],
  ["top_k", "Top K", 1],
  ["num_beams", "Beams", 1],
  ["repetition_penalty", "重复惩罚", 0.5],
  ["length_penalty", "长度惩罚", 0.1],
  ["max_mel_tokens", "Max mel tokens", 10],
  ["max_text_tokens_per_sentence", "分句最大 tokens", 10],
  ["sentences_bucket_max_size", "批次大小", 1],
];

export const MODE_LABELS: Record<Generation["mode"], string> = { normal: "普通推理", fast: "批次推理", batch: "并发推理" };

// Fields a mode ignores: bucketing is fast-only; batch samples best-of-N rows, so no length penalty.
const hidden = (key: keyof Generation, mode: Generation["mode"]) =>
  (key === "sentences_bucket_max_size" && mode !== "fast") || (key === "length_penalty" && mode === "batch");

export function GenerationParams({ value, onChange, open: initial = false }: { value: Generation; onChange: (g: Generation) => void; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  const set = (patch: Partial<Generation>) => onChange({ ...value, ...patch });
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <Segmented
          value={value.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: "normal", label: MODE_LABELS.normal },
            { value: "fast", label: MODE_LABELS.fast, title: "长文本更快" },
            { value: "batch", label: MODE_LABELS.batch, title: "多句同时解码，不排队；Beams 作为 best-of-N 采样。台本批量生成最快" },
          ]}
        />
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)}>
          <Sliders size={13} />
          高级参数
          <ChevronDown size={13} className={cx("transition-transform", open && "rotate-180")} />
        </button>
      </div>
      {open && (
        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2.5 sm:grid-cols-3">
          <label className="col-span-full flex cursor-pointer items-center gap-2 text-xs">
            <input type="checkbox" className="accent-[var(--accent)]" checked={value.do_sample} onChange={(e) => set({ do_sample: e.target.checked })} />
            启用采样（do_sample）
          </label>
          {NUMBERS.filter(([key]) => !hidden(key, value.mode)).map(([key, label, step]) => (
            <Field key={key} label={key === "num_beams" && value.mode === "batch" ? "Best-of-N" : label}>
              <input className="input h-7 tabular-nums" type="number" step={step} value={value[key] as number} onChange={(e) => set({ [key]: Number(e.target.value) })} />
            </Field>
          ))}
        </div>
      )}
    </div>
  );
}

/* Speaker name → role + reference audio. A regular role offers its samples/<name>/ files;
   an anonymous role (or no role) offers any audio, its own folder first. */
export function Bindings({ value, onChange, roles }: { value: Binding[]; onChange: (v: Binding[]) => void; roles: Role[] }) {
  const audio = useAudioOptions();
  const update = (index: number, patch: Partial<Binding>) => onChange(value.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  const roleOptions: Option[] = [
    { value: "", label: "无角色（任意音频）" },
    ...[...roles]
      .sort((a, b) => Number(a.anonymous) - Number(b.anonymous) || a.name.localeCompare(b.name, "zh"))
      .map((r) => ({ value: r.id, label: r.name, group: r.anonymous ? "匿名角色（任意音频）" : "角色（samples 文件夹）" })),
  ];
  function audioOptions(role?: Role): Option[] {
    const own = (role?.audio_ids ?? []).map((id) => ({ value: id, label: audio.names.get(id) || id.slice(0, 8), group: `samples/${role!.name}` }));
    if (role && !role.anonymous) return own;
    const mine = new Set(own.map((o) => o.value));
    return [...own, ...audio.options.filter((o) => !mine.has(o.value))];
  }
  return (
    <div className="space-y-1.5">
      {value.length > 0 && (
        <div className="grid grid-cols-[1fr_1fr_1.4fr_24px_32px] gap-1.5 px-0.5 text-[11px] font-medium text-muted">
          <span>文本中的说话人</span>
          <span>角色</span>
          <span>参考音频</span>
        </div>
      )}
      {value.map((b, i) => {
        const role = roles.find((r) => r.id === b.role_id);
        return (
          <div key={i} className="grid grid-cols-[1fr_1fr_1.4fr_24px_32px] items-center gap-1.5">
            <input className={cx("input", !b.speaker.trim() && "border-warn/60")} placeholder="如：旁白" value={b.speaker} onChange={(e) => update(i, { speaker: e.target.value })} />
            <Combobox
              label="角色"
              value={b.role_id ?? ""}
              options={roleOptions}
              onChange={(v) => {
                const r = roles.find((r) => r.id === v);
                // A regular role can only use its folder; anonymous keeps the current audio.
                const keep = !r || r.anonymous || (b.audio_id && r.audio_ids.includes(b.audio_id));
                update(i, { role_id: r?.id ?? null, audio_id: keep ? b.audio_id : (r.audio_ids[0] ?? null) });
              }}
            />
            <Combobox
              className={cx(!b.audio_id && "[&_input]:border-warn/60")}
              label="参考音频"
              value={b.audio_id}
              placeholder={role && !role.anonymous && !role.audio_ids.length ? `samples/${role.name}/ 为空` : "未绑定"}
              options={audioOptions(role)}
              onChange={(v) => void audio.resolve(v).then((record) => record && update(i, { audio_id: record.id }))}
            />
            <PlayButton id={b.audio_id} />
            <button className="btn btn-ghost btn-icon btn-danger" aria-label="移除" onClick={() => onChange(value.filter((_, n) => n !== i))}>
              <Trash2 size={14} />
            </button>
          </div>
        );
      })}
      <button className="btn btn-ghost btn-sm" onClick={() => onChange([...value, { speaker: "", role_id: null, audio_id: null }])}>
        <Plus size={13} />
        添加说话人
      </button>
    </div>
  );
}
