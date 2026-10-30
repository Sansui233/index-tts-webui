import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, isActive, taskTitle, type Task } from "./api";

/* Hash routes: #/speech, #/projects/<id>/sessions/<id>, ... */
export type Route =
  | { page: "speech" | "subtitles" | "sessions" | "roles" | "presets" | "apis" | "settings" }
  | { page: "projects"; projectId?: string }
  | { page: "session"; sessionId: string; projectId?: string };

function parse(hash: string): Route {
  const [page, a, b, c] = hash.replace(/^#\/?/, "").split("/");
  if (page === "projects" && b === "sessions" && c) return { page: "session", projectId: a, sessionId: c };
  if (page === "projects") return { page, projectId: a || undefined };
  if (page === "sessions" && a) return { page: "session", sessionId: a };
  if (["subtitles", "sessions", "roles", "presets", "apis", "settings"].includes(page)) return { page } as Route;
  return { page: "speech" };
}

export function useRoute() {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const update = () => setRoute(parse(location.hash));
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  return route;
}

export const go = (path: string) => (location.hash = "/" + path);

export type Theme = "light" | "dark" | "system";

function useThemeState() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("theme") as Theme) || "system");
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      (document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "dark" : "light") : theme);
    apply();
    localStorage.setItem("theme", theme);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return [theme, setTheme] as const;
}

/* App-wide state: task list (polled), model state, toasts. */
interface Toast {
  id: number;
  text: string;
  error: boolean;
}
interface AppState {
  tasks: Task[];
  model: string;
  toasts: Toast[];
  track: (task: Task) => void;
  /* Bumped when a task is submitted from this page, to replay the dock focus animation. */
  started: number;
  /* A task finished since the task sheet was last viewed. */
  unseen: boolean;
  markSeen: () => void;
  refreshTasks: () => void;
  notify: (text: string, error?: boolean) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
}
const Context = createContext<AppState>(null!);
export const useApp = () => useContext(Context);
export function useTheme() {
  const { theme, setTheme } = useApp();
  return [theme, setTheme] as const;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [model, setModel] = useState("unloaded");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const wake = useRef<() => void>(() => {});
  const [theme, setTheme] = useThemeState();
  const [started, setStarted] = useState(0);
  const [unseen, setUnseen] = useState(false);
  const markSeen = useCallback(() => setUnseen(false), []);
  const refreshTasks = useCallback(() => wake.current(), []);

  const notify = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 6000 : 3000);
  }, []);

  // Last seen status of active tasks, to flag and announce the ones that finish.
  const seen = useRef(new Map<string, Task["status"]>());
  const announce = useCallback(
    (list: Task[]) => {
      for (const task of list) {
        const before = seen.current.get(task.id);
        if (isActive(task)) seen.current.set(task.id, task.status);
        else if (before) {
          seen.current.delete(task.id);
          setUnseen(true);
          if (task.kind !== "merge") continue;
          if (task.status === "succeeded") notify(`合并完成：${taskTitle(task)}`);
          else if (task.status === "failed") notify(`合并失败：${task.error || task.message}`, true);
        }
      }
    },
    [notify],
  );

  const track = useCallback((task: Task) => {
    seen.current.set(task.id, task.status);
    setStarted((n) => n + 1);
    setTasks((t) => [task, ...t.filter((x) => x.id !== task.id)]);
    wake.current();
  }, []);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      clearTimeout(timer);
      let active = false;
      try {
        const [t, m] = await Promise.all([api.get<Task[]>("/tasks"), api.get<{ state: string }>("/models")]);
        if (!live) return;
        announce(t);
        setTasks(t);
        setModel(m.state);
        active = t.some(isActive) || m.state.endsWith("ing");
      } catch {
        /* backend restarting; keep polling */
      }
      if (live) timer = setTimeout(poll, active ? 800 : 4000);
    }
    wake.current = () => void poll();
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [announce]);

  return <Context.Provider value={{ tasks, model, toasts, track, started, unseen, markSeen, refreshTasks, notify, theme, setTheme }}>{children}</Context.Provider>;
}

/* Run an async action, toasting failures. Returns undefined on error. */
export function useAction() {
  const { notify } = useApp();
  return useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      try {
        const value = await fn();
        if (success) notify(success);
        return value;
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e), true);
      }
    },
    [notify],
  );
}

/* Fetch on mount and whenever deps change. */
export function useLoad<T>(path: string | null, initial: T) {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const run = useAction();
  const reload = useCallback(async () => {
    if (!path) return;
    const value = await run(() => api.get<T>(path));
    if (value !== undefined) setData(value);
    setLoading(false);
  }, [path, run]);
  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);
  return { data, setData, reload, loading };
}

/* Object state mirrored to localStorage (per-browser conveniences only). */
export function useStored<T extends object>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...initial, ...JSON.parse(raw) } : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  }, [key, value]);
  return [value, setValue] as const;
}
