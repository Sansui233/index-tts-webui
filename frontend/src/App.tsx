import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { Activity, AlertCircle, ArrowLeft, CheckCircle, CheckSquare, ChevronRight, FileText, Folder, Link, Mic, Monitor, Moon, Plus, Settings as Gear, Sun, Trash2, Users } from "react-feather";
import { api, isActive, taskTitle, type Named } from "./api";
import { TaskItem } from "./TaskItem";
import { AppProvider, go, useAction, useApp, useLoad, useRoute, useTheme, type Route } from "./state";
import { ask, confirm, cx, Dialogs, Progress, Segmented, Sheet, Spinner } from "./ui";
import { Apis } from "./pages/Apis";
import { Presets } from "./pages/Presets";
import { Roles } from "./pages/Roles";
import { SessionEditor } from "./pages/SessionEditor";
import { Projects, Sessions } from "./pages/Sessions";
import { Settings } from "./pages/Settings";
import { Speech } from "./pages/Speech";
import { Subtitles } from "./pages/Subtitles";

export default function App() {
  return (
    <AppProvider>
      <Shell />
      <Dialogs />
      <Toasts />
    </AppProvider>
  );
}

function Shell() {
  const route = useRoute();
  const projects = useLoad<Named[]>("/projects", []);
  const [tasksOpen, setTasksOpen] = useState(false);
  const inProjects = route.page === "projects" || (route.page === "session" && !!route.projectId);
  const project = "projectId" in route ? projects.data.find((p) => p.id === route.projectId) : undefined;

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex h-14 items-center gap-2.5 px-4">
          <span className="grid size-7 place-items-center rounded-lg bg-accent text-accent-fg">
            <Activity size={15} strokeWidth={2.5} />
          </span>
          <span className="font-semibold tracking-tight">IndexTTS</span>
          <span className="chip chip-accent">WebUI</span>
        </div>
        <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-1">
          {inProjects ? <ProjectMenu route={route} projects={projects.data} reload={projects.reload} /> : <MainMenu route={route} />}
        </nav>
        <Footer route={route} />
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto pb-16">
        <Content route={route} project={project} projects={projects.data} reloadProjects={projects.reload} />
      </main>
      <TaskDock onOpen={() => setTasksOpen(true)} />
      <TaskSheet open={tasksOpen} onClose={() => setTasksOpen(false)} />
    </div>
  );
}

function Content({ route, project, projects, reloadProjects }: { route: Route; project?: Named; projects: Named[]; reloadProjects: () => void }) {
  switch (route.page) {
    case "speech":
      return <Speech />;
    case "subtitles":
      return <Subtitles />;
    case "roles":
      return <Roles />;
    case "presets":
      return <Presets />;
    case "apis":
      return <Apis />;
    case "settings":
      return <Settings />;
    case "sessions":
      return <Sessions projects={projects} reloadProjects={reloadProjects} />;
    case "projects":
      return route.projectId ? (
        <Sessions key={route.projectId} project={project} projects={projects} reloadProjects={reloadProjects} />
      ) : (
        <Projects projects={projects} reload={reloadProjects} />
      );
    case "session":
      return <SessionEditor key={route.sessionId} id={route.sessionId} projects={projects} back={route.projectId ? `projects/${route.projectId}` : "sessions"} />;
  }
}

function NavItem({ active, icon, children, onClick, trailing, indent }: { active?: boolean; icon?: ReactNode; children: ReactNode; onClick: () => void; trailing?: ReactNode; indent?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left transition-colors",
        indent && "pl-9",
        active ? "bg-accent-soft font-medium text-accent" : "text-fg/80 hover:bg-hover hover:text-fg",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </button>
  );
}

function MainMenu({ route }: { route: Route }) {
  return (
    <>
      <NavItem icon={<Mic size={15} />} active={route.page === "speech"} onClick={() => go("speech")}>
        语音生成
      </NavItem>
      <NavItem icon={<FileText size={15} />} active={route.page === "subtitles"} onClick={() => go("subtitles")}>
        字幕生成
      </NavItem>
      <NavItem icon={<Users size={15} />} active={route.page === "sessions" || route.page === "session"} onClick={() => go("sessions")}>
        多人对话生成
      </NavItem>
      <NavItem indent active={route.page === "roles"} onClick={() => go("roles")}>
        角色管理
      </NavItem>
      <NavItem indent active={route.page === "presets"} onClick={() => go("presets")}>
        预设管理
      </NavItem>
      <NavItem indent onClick={() => go("projects")} trailing={<ChevronRight size={14} className="text-muted" />}>
        项目管理
      </NavItem>
      <NavItem icon={<Link size={15} />} active={route.page === "apis"} onClick={() => go("apis")}>
        API
      </NavItem>
    </>
  );
}

function ProjectMenu({ route, projects, reload }: { route: Route; projects: Named[]; reload: () => void }) {
  const run = useAction();
  const current = "projectId" in route ? route.projectId : undefined;
  async function create() {
    const values = await ask("新建项目", [{ key: "name", label: "项目名称" }], "创建");
    if (!values) return;
    const p = await run(() => api.post<Named>("/projects", values));
    if (p) {
      reload();
      go(`projects/${p.id}`);
    }
  }
  return (
    <>
      <NavItem icon={<ArrowLeft size={15} />} onClick={() => go("sessions")}>
        返回
      </NavItem>
      <div className="flex items-center justify-between px-2.5 pt-3 pb-1">
        <button className="cursor-pointer text-[11px] font-semibold tracking-wide text-muted uppercase hover:text-fg" onClick={() => go("projects")}>
          项目
        </button>
        <button className="btn btn-ghost btn-sm btn-icon" title="新建项目" onClick={() => void create()}>
          <Plus size={14} />
        </button>
      </div>
      {projects.map((p) => (
        <NavItem key={p.id} icon={<Folder size={15} />} active={current === p.id} onClick={() => go(`projects/${p.id}`)}>
          {p.name}
        </NavItem>
      ))}
      {!projects.length && <p className="px-2.5 py-2 text-xs text-muted">还没有项目</p>}
    </>
  );
}

const MODEL_LABEL: Record<string, string> = { loaded: "模型已加载", loading: "模型加载中", unloaded: "模型未加载", unloading: "模型卸载中", error: "模型加载失败" };

function Footer({ route }: { route: Route }) {
  const { model } = useApp();
  const [theme, setTheme] = useTheme();
  return (
    <div className="border-t border-line p-2">
      <button onClick={() => go("settings")} title="模型管理" className="mb-1.5 flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-xs text-muted hover:bg-hover">
        <span className={cx("size-2 rounded-full", model === "loaded" ? "bg-ok" : model === "error" ? "bg-danger" : model.endsWith("ing") ? "animate-pulse bg-warn" : "bg-line")} />
        <span className="flex-1 text-left">{MODEL_LABEL[model] || model}</span>
      </button>
      <div className="flex items-center justify-between">
        <button title="设置" aria-label="设置" className={cx("btn btn-ghost btn-icon", route.page === "settings" && "text-accent")} onClick={() => go("settings")}>
          <Gear size={16} />
        </button>
        <Segmented
          value={theme}
          onChange={setTheme}
          options={[
            { value: "light", label: <Sun size={13} />, title: "日间" },
            { value: "dark", label: <Moon size={13} />, title: "夜间" },
            { value: "system", label: <Monitor size={13} />, title: "跟随系统" },
          ]}
        />
      </div>
    </div>
  );
}

/* Bottom-right, next to where the drawer opens: idle icon, or live progress while working. */
function TaskDock({ onOpen }: { onOpen: () => void }) {
  const { tasks, started, unseen } = useApp();
  const active = tasks.filter(isActive);
  const current = active.find((t) => t.status === "running") || active[0];
  const running = active.some((t) => t.status === "running");
  return (
    <button
      onClick={onOpen}
      aria-label={unseen ? "任务（有新完成）" : "任务"}
      className={cx(
        "fixed right-4 bottom-4 z-30 flex h-10 cursor-pointer items-center gap-2.5 rounded-full border border-line bg-panel shadow-lg transition-all hover:border-accent/40",
        current ? "w-72 pr-4 pl-3" : "w-10 justify-center",
      )}
      title="任务"
    >
      {running && (
        <span className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-[inherit]">
          <span className="task-wave" />
          <span className="task-wave task-wave-back" />
        </span>
      )}
      {started > 0 && <span key={started} className="task-focus" />}
      {unseen && <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-accent ring-2 ring-bg" />}
      {current ? (
        <>
          <Spinner className="shrink-0" />
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-xs font-medium">{taskTitle(current) || current.message || "排队中"}</span>
            <Progress value={current.progress} className="mt-1" />
          </span>
          {active.length > 1 && <span className="chip chip-accent">+{active.length - 1}</span>}
        </>
      ) : (
        <Activity size={16} className="text-muted" />
      )}
    </button>
  );
}

function TaskSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { tasks, unseen, markSeen, refreshTasks, notify } = useApp();
  const run = useAction();
  const [selected, setSelected] = useState<Set<string> | null>(null);
  // Viewing the sheet, or having it open as tasks finish, counts as seen.
  useEffect(() => {
    if (open && unseen) markSeen();
  }, [open, unseen, markSeen]);
  useEffect(() => {
    if (!open) setSelected(null);
  }, [open]);

  const shown = tasks.slice(0, 50);
  const finished = shown.filter((t) => !isActive(t));
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  async function remove(e: MouseEvent, path: string, body: unknown, message: string, action: string) {
    if (!(await confirm(e, message, action))) return;
    const result = await run(() => api.post<{ deleted: number }>(path, body));
    if (!result) return;
    notify(`已删除 ${result.deleted} 条任务记录`);
    setSelected(null);
    refreshTasks();
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={selected ? `已选 ${selected.size} 项` : "任务"}
      actions={
        <>
          <button
            className={cx("tip tip-below btn btn-ghost btn-icon", selected && "bg-hover text-fg")}
            data-tip={selected ? "退出多选" : "多选"}
            aria-label="多选"
            disabled={!finished.length}
            onClick={() => setSelected(selected ? null : new Set())}
          >
            <CheckSquare size={15} />
          </button>
          {!selected && (
            <button
              className="tip tip-below btn btn-ghost btn-icon btn-danger"
              data-tip="清除已结束的任务"
              aria-label="清除已结束的任务"
              disabled={!finished.length}
              onClick={(e) => void remove(e, "/tasks/clear", undefined, "清除所有已结束（完成、失败、取消、中断）的任务记录？生成的音频不受影响。", "清除")}
            >
              <Trash2 size={15} />
            </button>
          )}
        </>
      }
      footer={
        selected && (
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => setSelected(selected.size === finished.length ? new Set() : new Set(finished.map((t) => t.id)))}>
              {selected.size === finished.length ? "全不选" : "全选"}
            </button>
            <span className="flex-1" />
            <button className="btn btn-sm" onClick={() => setSelected(null)}>
              取消
            </button>
            <button
              className="btn btn-sm btn-danger"
              disabled={!selected.size}
              onClick={(e) => void remove(e, "/tasks/delete", { ids: [...selected] }, `删除所选 ${selected.size} 条任务记录？生成的音频不受影响。`, "删除")}
            >
              <Trash2 size={13} />
              删除
            </button>
          </>
        )
      }
    >
      <div className="-mt-2.5 divide-y divide-line">
        {shown.map((t) => (
          <TaskItem key={t.id} task={t} selecting={!!selected} selected={selected?.has(t.id)} onSelect={() => toggle(t.id)} />
        ))}
      </div>
      {!tasks.length && <p className="py-8 text-center text-muted">暂无任务</p>}
    </Sheet>
  );
}

function Toasts() {
  const { toasts } = useApp();
  return (
    <div className="pointer-events-none fixed top-4 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} role="status" className={cx("card flex items-start gap-2 px-3.5 py-2.5 text-[13px] shadow-lg", t.error && "border-danger/40")}>
          {t.error ? <AlertCircle size={15} className="mt-px shrink-0 text-danger" /> : <CheckCircle size={15} className="mt-px shrink-0 text-ok" />}
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
