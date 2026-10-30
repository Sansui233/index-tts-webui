import { useState, type MouseEvent } from "react";
import { Bookmark, Plus, Trash2 } from "react-feather";
import { api, defaultGeneration, type Binding, type Generation, type Preset, type Role } from "../api";
import { useAction, useLoad } from "../state";
import { ago, confirm, Empty, Field, Page, PageHeader, Sheet } from "../ui";
import { Bindings, GenerationParams, MODE_LABELS } from "../widgets";

type Draft = { id?: string; name: string; bindings: Binding[]; generation: Generation };
const toDraft = (p?: Preset): Draft => ({ id: p?.id, name: p?.name || "", bindings: p?.bindings || [], generation: p?.generation || defaultGeneration });

export function Presets() {
  const presets = useLoad<Preset[]>("/presets", []);
  const roles = useLoad<Role[]>("/roles", []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const roleName = new Map(roles.data.map((r) => [r.id, r.name]));

  return (
    <Page>
      <PageHeader title="预设管理" sub={`${presets.data.length} 个预设 · 说话人绑定与推理参数`}>
        <button className="btn btn-primary" onClick={() => setDraft(toDraft())}>
          <Plus size={14} />
          新建预设
        </button>
      </PageHeader>
      {presets.data.length ? (
        <div className="card overflow-hidden">
          {presets.data.map((p) => (
            <div
              key={p.id}
              role="button"
              tabIndex={0}
              onClick={() => setDraft(toDraft(p))}
              onKeyDown={(e) => e.key === "Enter" && setDraft(toDraft(p))}
              className="grid cursor-pointer grid-cols-[minmax(0,1fr)_100px] items-center gap-3 border-b border-line px-4 py-2.5 last:border-0 hover:bg-panel"
            >
              <span className="min-w-0">
                <span className="flex items-center gap-2.5">
                  <Bookmark size={14} className="shrink-0 text-accent" />
                  <span className="truncate font-medium">{p.name}</span>
                  <span className="chip">{MODE_LABELS[p.generation.mode]}</span>
                </span>
                <span className="mt-1 flex flex-wrap gap-1 pl-6">
                  {p.bindings.map((b) => (
                    <span key={b.speaker} className="chip">
                      {b.speaker}
                      {b.role_id && roleName.get(b.role_id) && roleName.get(b.role_id) !== b.speaker && <span className="text-muted"> → {roleName.get(b.role_id)}</span>}
                    </span>
                  ))}
                  {!p.bindings.length && <span className="text-xs text-muted">无说话人</span>}
                </span>
              </span>
              <span className="text-right text-xs text-muted">{ago(p.updated_at)}</span>
            </div>
          ))}
        </div>
      ) : (
        !presets.loading && (
          <Empty icon={<Bookmark size={18} />} title="还没有预设">
            在此新建，或在 session 设置中把说话人绑定存为预设
          </Empty>
        )
      )}
      {draft && (
        <PresetEditor
          draft={draft}
          roles={roles.data}
          onClose={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            void presets.reload();
          }}
        />
      )}
    </Page>
  );
}

function PresetEditor({ draft: initial, roles, onClose, onSaved }: { draft: Draft; roles: Role[]; onClose: () => void; onSaved: () => void }) {
  const run = useAction();
  const [draft, setDraft] = useState(initial);

  async function save() {
    const body = { name: draft.name, bindings: draft.bindings, generation: draft.generation };
    if (await run(() => (draft.id ? api.put(`/presets/${draft.id}`, body) : api.post("/presets", body)), "预设已保存")) onSaved();
  }
  async function remove(e: MouseEvent) {
    if (!(await confirm(e, `删除预设「${draft.name}」？已使用它的 session 不受影响。`))) return;
    if (await run(() => api.del(`/presets/${draft.id}`), "预设已删除")) onSaved();
  }
  return (
    <Sheet
      open
      wide
      onClose={onClose}
      title={draft.id ? "编辑预设" : "新建预设"}
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
          <button className="btn btn-primary" disabled={!draft.name.trim()} onClick={() => void save()}>
            保存
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="名称">
          <input className="input" autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <div>
          <span className="label">说话人绑定</span>
          <Bindings value={draft.bindings} onChange={(bindings) => setDraft({ ...draft, bindings })} roles={roles} />
        </div>
        <div>
          <span className="label">推理参数</span>
          <GenerationParams value={draft.generation} onChange={(generation) => setDraft({ ...draft, generation })} />
        </div>
      </div>
    </Sheet>
  );
}
