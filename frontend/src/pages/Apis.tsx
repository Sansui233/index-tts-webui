import { useEffect, useState, type MouseEvent } from "react";
import { AlertTriangle, BookOpen, ChevronDown, Download, Edit2, ExternalLink, Headphones, Eye, EyeOff, Link, Lock, Play, Plus, RefreshCw, Trash2 } from "react-feather";
import { api, defaultGeneration, type ApiEndpoint, type Generation, type Voice } from "../api";
import { PlayButton } from "../player";
import { TaskItem } from "../TaskItem";
import { useAction, useApp, useLoad, useStored } from "../state";
import { confirm, CopyButton, cx, Empty, Field, Modal, Page, PageHeader, promptAt, Section, Segmented, Sheet, Spinner } from "../ui";
import { AudioPicker, GenerationParams, useAudioOptions } from "../widgets";

type Draft = { id?: string; name: string; slug: string; access: ApiEndpoint["access"]; enabled: boolean; voices: Voice[]; generation: Generation };
const toDraft = (a?: ApiEndpoint): Draft => ({
  id: a?.id,
  name: a?.name || "",
  slug: a?.slug || "",
  access: a?.access || "public",
  enabled: a?.enabled ?? true,
  voices: a?.voices || [],
  generation: a?.generation || defaultGeneration,
});
const body = (a: Draft | ApiEndpoint) => ({ name: a.name, slug: a.slug, access: a.access, enabled: a.enabled, voices: a.voices, generation: a.generation });

const endpoint = (a: ApiEndpoint) => `${location.origin}/tts/${a.slug}`;
/* What to copy for a voice: public, a GET link to append text to; private, a curl call. */
function voiceLink(a: ApiEndpoint, voice: string) {
  if (a.access === "public") return `${endpoint(a)}?voice=${encodeURIComponent(voice)}&text=`;
  const data = JSON.stringify({ text: "你好", voice });
  return `curl -X POST "${endpoint(a)}" -H "Authorization: Bearer ${a.token}" -H "Content-Type: application/json" -d '${data}' -o out.wav`;
}
const stem = (name: string) => name.split("/").pop()!.replace(/\.[^.]+$/, "");

export function Apis() {
  const apis = useLoad<ApiEndpoint[]>("/apis", []);
  const { tasks } = useApp();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [help, setHelp] = useState(false);
  const recent = tasks.filter((t) => t.kind === "api").slice(0, 10);
  const replace = (next: ApiEndpoint) => apis.setData((list) => list.map((a) => (a.id === next.id ? next : a)));

  return (
    <Page>
      <PageHeader title="API" sub="把语音生成开放给其他程序：公开链接（GET / POST），或带 token 的私有接口（POST）">
        <button className="btn" onClick={() => setHelp(true)}>
          <BookOpen size={14} />
          调用说明
        </button>
        <button className="btn btn-primary" onClick={() => setDraft(toDraft())}>
          <Plus size={14} />
          新建 API
        </button>
      </PageHeader>
      <div className="space-y-4">
        {apis.data.map((a) => (
          <ApiCard key={a.id} value={a} onChange={replace} onEdit={() => setDraft(toDraft(a))} />
        ))}
        {!apis.data.length && !apis.loading && (
          <Empty icon={<Link size={18} />} title="还没有 API">
            新建一个 API，再为常用的参考音频生成链接
          </Empty>
        )}
        <Section title="最近调用" extra={<span className="text-xs text-muted">{recent.length} 条</span>}>
          {recent.length ? (
            <div className="-my-2.5 divide-y divide-line">
              {recent.map((t) => (
                <TaskItem key={t.id} task={t} />
              ))}
            </div>
          ) : (
            <p className="py-4 text-center text-xs text-muted">API 调用会作为任务出现在这里</p>
          )}
        </Section>
      </div>
      {help && <Usage onClose={() => setHelp(false)} />}
      {draft && (
        <ApiEditor
          draft={draft}
          onClose={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            void apis.reload();
          }}
        />
      )}
    </Page>
  );
}

function ApiCard({ value: a, onChange, onEdit }: { value: ApiEndpoint; onChange: (a: ApiEndpoint) => void; onEdit: () => void }) {
  const run = useAction();
  const audio = useAudioOptions();
  const [adding, setAdding] = useState<{ name: string; audio_id: string | null } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [view, setView] = useStored(`api-voices:${a.id}`, { open: false });
  const [profiles, setProfiles] = useState(false);

  async function saveVoices(voices: Voice[], success: string) {
    const next = await run(() => api.put<ApiEndpoint>(`/apis/${a.id}`, { ...body(a), voices }), success);
    if (next) onChange(next);
    return !!next;
  }
  async function add() {
    if (!adding?.audio_id || !adding.name.trim()) return;
    if (await saveVoices([...a.voices, { name: adding.name.trim(), audio_id: adding.audio_id }], "已生成链接")) setAdding(null);
  }
  async function remove(e: MouseEvent, voice: Voice) {
    if (await confirm(e, `删除音色「${voice.name}」？使用这个链接的调用将失效。`)) await saveVoices(a.voices.filter((v) => v !== voice), "音色已删除");
  }
  async function test(e: MouseEvent, voice: string) {
    const text = await promptAt(e, "测试文本", "你好，这是一段测试语音。", "生成");
    if (!text?.trim()) return;
    setTesting(voice);
    // Through the real endpoint, exactly as a client would call it; the result shows in 最近调用.
    await run(async () => {
      const init = a.access === "public" ? { method: "GET" } : { method: "POST", headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ text, voice }) };
      const url = a.access === "public" ? `/tts/${a.slug}?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(text)}` : `/tts/${a.slug}`;
      const response = await fetch(url, init);
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail || response.statusText);
    }, "测试成功");
    setTesting(null);
  }
  async function regenerate(e: MouseEvent) {
    if (!(await confirm(e, "重新生成 token？旧 token 立即失效。", "重新生成"))) return;
    const next = await run(() => api.post<ApiEndpoint>(`/apis/${a.id}/token`), "token 已更新");
    if (next) onChange(next);
  }

  return (
    <section className={cx("card", !a.enabled && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <span className="font-semibold">{a.name}</span>
        <span className={cx("chip", a.access === "private" && "chip-accent")}>
          {a.access === "private" && <Lock size={10} />}
          {a.access === "private" ? "私有" : "公开"}
        </span>
        {!a.enabled && <span className="chip text-warn">已停用</span>}
        <span className="flex-1" />
        <button className="btn btn-ghost btn-sm" disabled={!a.voices.length} title={a.voices.length ? undefined : "先生成音色链接"} onClick={() => setProfiles(true)}>
          <Headphones size={13} />
          听书配置
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onEdit}>
          <Edit2 size={13} />
          设置
        </button>
      </div>
      <div className="space-y-3 px-4 py-3">
        <div className="flex items-center gap-2 text-xs">
          <span className="w-12 shrink-0 text-muted">地址</span>
          <span className="chip font-mono">{a.access === "public" ? "GET / POST" : "POST"}</span>
          <code className="min-w-0 truncate font-mono">{endpoint(a)}</code>
          <CopyButton text={endpoint(a)} label="复制地址" />
        </div>
        {a.access === "private" && a.token && <Token token={a.token} onRegenerate={regenerate} />}
      </div>
      <div className="border-t border-line">
        <div className="flex items-center justify-between px-4 py-1.5">
          <button className="-ml-1 flex cursor-pointer items-center gap-1 rounded px-1 py-1 text-xs font-medium text-muted hover:text-fg" aria-expanded={view.open} onClick={() => setView({ open: !view.open })}>
            <ChevronDown size={13} className={cx("transition-transform", !view.open && "-rotate-90")} />
            已保存的音色（{a.voices.length}）
          </button>
          {!adding && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setView({ open: true });
                setAdding({ name: "", audio_id: null });
              }}
            >
              <Plus size={13} />
              生成链接
            </button>
          )}
        </div>
        <div className={cx("divide-y divide-line", !view.open && "hidden")}>
          {a.voices.map((v) => (
            <div key={v.name} className="grid grid-cols-[minmax(0,160px)_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2">
              <span className="min-w-0">
                <span className="block truncate font-medium">{v.name}</span>
                <span className="block truncate text-[11px] text-muted">{audio.names.get(v.audio_id) || "音频缺失"}</span>
              </span>
              <code className="min-w-0 truncate rounded bg-panel px-2 py-1 font-mono text-[11px] text-muted" title={voiceLink(a, v.name)}>
                {voiceLink(a, v.name)}
              </code>
              <span className="flex items-center">
                <PlayButton id={v.audio_id} />
                <CopyButton text={voiceLink(a, v.name)} label={a.access === "public" ? "复制链接（末尾接文本）" : "复制 curl 命令"} />
                <button className="tip btn btn-ghost btn-sm btn-icon" data-tip="测试生成" aria-label="测试生成" disabled={!a.enabled || !!testing} onClick={(e) => void test(e, v.name)}>
                  {testing === v.name ? <Spinner /> : <Play size={13} />}
                </button>
                <button className="tip btn btn-ghost btn-sm btn-icon btn-danger" data-tip="删除" aria-label="删除" onClick={(e) => void remove(e, v)}>
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
          ))}
          {!a.voices.length && !adding && <p className="px-4 pb-3 text-xs text-muted">还没有保存音色。也可以不保存，直接用任意参考音频调用（见右上角「调用说明」）。</p>}
        </div>
        {adding && (
          <div className="grid gap-2 border-t border-line bg-panel px-4 py-3 sm:grid-cols-[180px_minmax(0,1fr)]">
            <Field label="音色名（链接中的 voice）">
              <input className="input" autoFocus value={adding.name} placeholder="如：kaveh" onChange={(e) => setAdding({ ...adding, name: e.target.value })} onKeyDown={(e) => e.key === "Enter" && void add()} />
            </Field>
            <div>
              <span className="label">参考音频</span>
              <AudioPicker
                value={adding.audio_id}
                onChange={(id, record) => {
                  // A samples file outside role folders is registered on first pick: tell this card's list.
                  if (record && !audio.names.has(record.id)) audio.add(record);
                  setAdding((d) => d && { audio_id: id, name: d.name || (record ? stem(record.name) : "") });
                }}
              />
            </div>
            <div className="col-span-full flex justify-end gap-2">
              <button className="btn btn-sm" onClick={() => setAdding(null)}>
                取消
              </button>
              <button className="btn btn-primary btn-sm" disabled={!adding.audio_id || !adding.name.trim()} onClick={() => void add()}>
                保存并生成链接
              </button>
            </div>
          </div>
        )}
      </div>
      {profiles && <Profiles value={a} onClose={() => setProfiles(false)} />}
    </section>
  );
}

function Token({ token, onRegenerate }: { token: string; onRegenerate: (e: MouseEvent) => void }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-12 shrink-0 text-muted">Token</span>
      <code className="min-w-0 truncate font-mono">{shown ? token : token.slice(0, 4) + "•".repeat(20)}</code>
      <button className="tip btn btn-ghost btn-sm btn-icon" data-tip={shown ? "隐藏" : "显示"} aria-label={shown ? "隐藏" : "显示"} onClick={() => setShown(!shown)}>
        {shown ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
      <CopyButton text={token} label="复制 token" />
      <button className="tip btn btn-ghost btn-sm btn-icon" data-tip="重新生成" aria-label="重新生成" onClick={onRegenerate}>
        <RefreshCw size={13} />
      </button>
    </div>
  );
}

function ApiEditor({ draft: initial, onClose, onSaved }: { draft: Draft; onClose: () => void; onSaved: () => void }) {
  const run = useAction();
  const [draft, setDraft] = useState(initial);
  const valid = draft.name.trim() && /^[a-zA-Z0-9_-]+$/.test(draft.slug);

  async function save() {
    if (await run(() => (draft.id ? api.put(`/apis/${draft.id}`, body(draft)) : api.post("/apis", body(draft))), "API 已保存")) onSaved();
  }
  async function remove(e: MouseEvent) {
    if (!(await confirm(e, `删除 API「${draft.name}」？它的地址和所有音色链接将失效。`))) return;
    if (await run(() => api.del(`/apis/${draft.id}`), "API 已删除")) onSaved();
  }
  return (
    <Sheet
      open
      onClose={onClose}
      title={draft.id ? "API 设置" : "新建 API"}
      footer={
        <>
          {draft.id && (
            <button className="btn btn-ghost btn-danger" onClick={(e) => void remove(e)}>
              <Trash2 size={14} />
              删除
            </button>
          )}
          <span className="flex-1" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!valid} onClick={() => void save()}>
            保存
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="名称">
          <input className="input" autoFocus value={draft.name} placeholder="如：直播读弹幕" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <Field label="路径">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-xs text-muted">/tts/</span>
            <input className={cx("input font-mono", draft.slug && !valid && "border-warn/60")} value={draft.slug} placeholder="live" onChange={(e) => setDraft({ ...draft, slug: e.target.value.trim() })} />
          </div>
          <span className="mt-1 block text-[11px] text-muted">字母、数字、- 和 _；修改后旧地址失效</span>
        </Field>
        <div>
          <span className="label">访问方式</span>
          <Segmented
            value={draft.access}
            onChange={(access) => setDraft({ ...draft, access })}
            options={[
              { value: "public", label: "公开（GET / POST）" },
              { value: "private", label: "私有（POST + token）" },
            ]}
          />
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
            {draft.access === "public" ? "任何能访问本机地址的人都可以调用。" : "调用需带 Authorization: Bearer <token>；token 保存后生成。"}
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <input type="checkbox" className="accent-[var(--accent)]" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
          启用（停用后地址返回 404，配置保留）
        </label>
        <div>
          <span className="label">推理参数（调用方可在 POST 的 generation 中逐项覆盖）</span>
          <GenerationParams value={draft.generation} onChange={(generation) => setDraft({ ...draft, generation })} />
        </div>
      </div>
    </Sheet>
  );
}

function Usage({ onClose }: { onClose: () => void }) {
  return (
    <Modal width="max-w-3xl" title="调用说明" onClose={onClose}>
      <div className="space-y-3 text-xs leading-relaxed">
        <p>
          <code className="font-mono">voice</code> 可以是 API 中已保存的音色名，也可以是服务器上<b>任意参考音频</b>：参考音频 id，或 samples 内的相对路径（如{" "}
          <code className="font-mono">卡维/0 正常.wav</code>）。生成完成后直接返回 <code className="font-mono">audio/wav</code>，响应头{" "}
          <code className="font-mono">X-Task-Id</code> 为对应任务。
        </p>
        <pre className="overflow-x-auto rounded-md bg-panel p-3 font-mono text-[11px]">{`# 可用音色：已保存的音色、samples 路径、上传音频 id（私有 API 需带 token）
GET  /tts/<路径>/voices

# 公开：GET（参数需 URL 编码）或 POST
GET  /tts/<路径>?voice=<音色>&text=<文本>

# 私有：仅 POST
POST /tts/<路径>
Authorization: Bearer <token>
Content-Type: application/json

{ "text": "你好", "voice": "<音色>", "generation": { "temperature": 0.9 } }

# POST 也接受表单字段或 URL 参数：text、voice（听书软件用这种方式）`}</pre>
        <p className="text-muted">
          任务与界面共用一个队列，排在前面的生成完成后才会执行；最多等待 10 分钟，超时返回 504 并取消。错误码：400 参数错误 · 401 token 错误 · 404 API 或音色不存在 · 405 私有 API 用了 GET ·
          500 生成失败。仅在本机（127.0.0.1）可访问，局域网调用需用 <code className="font-mono">--host 0.0.0.0</code> 启动。
        </p>
        <References />
      </div>
    </Modal>
  );
}

/* Every reference audio with the `voice` value that names it: samples by path, uploads by id. */
function References() {
  const audio = useAudioOptions();
  const [query, setQuery] = useState("");
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = audio.options
    .map((o) => ({ ...o, voice: o.group === "samples" ? o.label : o.value }))
    .filter((o) => terms.every((t) => o.label.toLowerCase().includes(t)));
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-medium">可用参考音频（{audio.options.length}）</span>
        <input className="input h-7 w-48" placeholder="筛选" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line">
        {rows.map((o) => (
          <div key={o.value} className="flex items-center gap-2 px-3 py-1">
            <span className="chip shrink-0">{o.group === "samples" ? "samples" : "上传"}</span>
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
            {o.group !== "samples" && <code className="truncate font-mono text-[11px] text-muted">{o.voice}</code>}
            <CopyButton text={o.voice} label="复制 voice 值" />
          </div>
        ))}
        {!rows.length && <p className="px-3 py-3 text-center text-muted">没有匹配的音频</p>}
      </div>
    </div>
  );
}

type App = "legado" | "ireadnote" | "reader";
const APPS: Record<App, { label: string; format: "legado" | "ireadnote"; steps: string }> = {
  legado: { label: "阅读", format: "legado", steps: "在装有阅读的手机上点「一键导入」；或在 朗读引擎 → 右上角 ⋮ → 网络导入 中粘贴链接，也可下载后用「本地导入」。单个音色可复制配置，在新建引擎的 ⋮ 菜单中「粘贴源」。" },
  ireadnote: { label: "爱阅记", format: "ireadnote", steps: "复制配置，在 在线语音库管理 → 右上角 ⋮ → JSON 输入 中粘贴。所有音色合为一个语音库，朗读时可切换。" },
  reader: { label: "服务端阅读", format: "legado", steps: "服务端阅读（hectorqin/reader）使用阅读的格式：在朗读设置的 HttpTTS 中用网络导入粘贴链接，或导入下载的 JSON。语音由 reader 服务器请求，地址需能从该服务器访问。" },
};
const LOCAL = /^https?:\/\/(localhost|127\.|\[::1\])/i;

/* 听书配置: the saved voices as TTS engines for reader apps (formats from yy4382/tts-importer). */
function Profiles({ value: a, onClose }: { value: ApiEndpoint; onClose: () => void }) {
  const [app, setApp] = useState<App>("legado");
  const [stored, setStored] = useStored("tts-profile-base", { base: location.origin });
  const base = stored.base.trim().replace(/\/+$/, "");
  const valid = /^https?:\/\/[^/\s]+$/i.test(base);
  const format = APPS[app].format;
  const [result, setResult] = useState<{ text: string; count: number } | { error: string } | null>(null);

  useEffect(() => {
    if (!valid) return setResult({ error: "服务器地址需以 http:// 或 https:// 开头，不含路径" });
    let live = true;
    api
      .get<unknown>(`/apis/${a.id}/profile/${format}?base=${encodeURIComponent(base)}`)
      .then((data) => {
        // A single 阅读 engine is copied as one object, which「粘贴源」expects.
        const value = Array.isArray(data) && data.length === 1 ? data[0] : data;
        if (live) setResult({ text: JSON.stringify(value, null, 2), count: Array.isArray(data) ? data.length : a.voices.length });
      })
      .catch((e: Error) => live && setResult({ error: e.message }));
    return () => {
      live = false;
    };
  }, [a.id, a.voices.length, a.access, a.token, a.slug, a.name, format, base, valid]);

  const network = `${base}/tts/${a.slug}/profile/legado${a.access === "private" ? `?token=${encodeURIComponent(a.token || "")}` : ""}`;
  function download(text: string) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    Object.assign(document.createElement("a"), { href: url, download: `${a.slug}-${app}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  return (
    <Modal width="max-w-2xl" title={`听书配置 · ${a.name}`} onClose={onClose}>
      <div className="space-y-4 text-xs leading-relaxed">
        <Segmented value={app} onChange={setApp} options={(Object.keys(APPS) as App[]).map((k) => ({ value: k, label: APPS[k].label }))} />
        <Field label="服务器地址（听书软件访问本机的地址）">
          <input className={cx("input font-mono", !valid && "border-warn/60")} value={stored.base} placeholder="http://192.168.1.5:7863" onChange={(e) => setStored({ base: e.target.value })} />
        </Field>
        {LOCAL.test(base) && (
          <p className="flex gap-1.5 text-warn">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            手机或其他设备无法访问 localhost / 127.0.0.1：请填写本机的局域网地址，并用 --host 0.0.0.0 启动。
          </p>
        )}
        {!a.enabled && <p className="text-warn">这个 API 已停用，导入后调用会返回 404。</p>}
        <p className="text-muted">{APPS[app].steps}</p>
        {result && "error" in result ? (
          <p className="text-danger">{result.error}</p>
        ) : (
          result && (
            <>
              <div className="flex flex-wrap gap-2">
                {app === "legado" && (
                  <a className="btn btn-sm btn-primary" href={`legado://import/httpTTS?src=${encodeURIComponent(network)}`}>
                    <ExternalLink size={13} />
                    一键导入
                  </a>
                )}
                {format === "legado" && <CopyButton text={network}>复制网络导入链接</CopyButton>}
                <CopyButton text={result.text}>复制配置</CopyButton>
                <button className="btn btn-sm" onClick={() => download(result.text)}>
                  <Download size={13} />
                  下载 JSON
                </button>
              </div>
              <div>
                <span className="label">
                  配置预览（{result.count} 个音色{a.access === "private" ? "，含 token，请勿公开" : ""}）
                </span>
                <pre className="max-h-64 overflow-auto rounded-md bg-panel p-3 font-mono text-[11px]">{result.text}</pre>
              </div>
            </>
          )
        )}
        <p className="text-muted">
          只包含已保存的音色；朗读时由软件按句请求本 API，语速等参数沿用 API 的推理参数。配置格式参考{" "}
          <a className="text-accent underline" href="https://github.com/yy4382/tts-importer" target="_blank" rel="noreferrer">
            tts-importer
          </a>
          。
        </p>
      </div>
    </Modal>
  );
}
