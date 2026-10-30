import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Copy, Edit2, X } from "react-feather";

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

export function PageHeader({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[22px] leading-snug font-semibold tracking-tight [overflow-wrap:anywhere]">{title}</h1>
        {sub && <p className="mt-0.5 text-muted">{sub}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}

export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={cx("mx-auto w-full px-6 py-7 lg:px-10", wide ? "max-w-[1400px]" : "max-w-[1120px]")}>{children}</div>;
}

export function Section({ title, extra, children, className }: { title?: ReactNode; extra?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("card p-4", className)}>
      {(title || extra) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-[13px] font-semibold">{title}</h2>
          {extra}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block min-w-0", className)}>
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-6 py-12 text-center text-muted">
      {icon && <div className="mb-1 grid size-10 place-items-center rounded-full bg-accent-soft text-accent">{icon}</div>}
      <p className="font-medium text-fg">{title}</p>
      {children}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-lg bg-hover p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            "flex h-7 cursor-pointer items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors",
            value === o.value ? "bg-bg text-fg shadow-sm" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cx("h-1 overflow-hidden rounded-full bg-hover", className)}>
      <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx("inline-block size-3.5 animate-spin rounded-full border-2 border-accent/25 border-t-accent", className)} />;
}

/* Escape closes only the most recently opened layer (popover over modal over sheet). */
const layers: { current: () => void }[] = [];
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && layers.length) layers[layers.length - 1].current();
});

export function useEscape(onClose: () => void, active = true) {
  const handler = useRef(onClose);
  handler.current = onClose;
  useEffect(() => {
    if (!active) return;
    layers.push(handler);
    return () => void layers.splice(layers.indexOf(handler), 1);
  }, [active]);
}

/* Right-side drawer. */
export function Sheet({ open, title, onClose, children, footer, actions, wide }: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; actions?: ReactNode; wide?: boolean }) {
  useEscape(onClose, open);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20 dark:bg-black/40" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className={cx("flex h-full w-full flex-col border-l border-line bg-bg shadow-2xl", wide ? "max-w-[640px]" : "max-w-[420px]")}>
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-line pr-2 pl-4">
          <h2 className="font-semibold">{title}</h2>
          <div className="flex items-center gap-0.5">
            {actions}
            <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="关闭">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex shrink-0 items-center gap-2 border-t border-line p-3">{footer}</div>}
      </aside>
    </div>
  );
}

/* Promise-based dialogs replacing window.prompt / confirm. */
export interface DialogField {
  key: string;
  label: string;
  value?: string;
  options?: { value: string; label: string }[];
}
interface DialogRequest {
  title: string;
  fields: DialogField[];
  action: string;
  resolve: (values: Record<string, string> | null) => void;
}
/* Popover at the pointer: a confirmation, or a one-field prompt when `input` is set. */
interface ConfirmRequest {
  x: number;
  y: number;
  message: string;
  action: string;
  input?: string;
  choices?: Choice[];
  resolve: (value: string | null) => void;
}
export interface Choice {
  value: string;
  label: string;
  hint?: string;
}
type Anchor = { clientX: number; clientY: number; currentTarget: EventTarget | null };
let showDialog: (request: DialogRequest) => void = () => {};
let showConfirm: (request: ConfirmRequest) => void = () => {};

export function ask(title: string, fields: DialogField[], action = "确定") {
  return new Promise<Record<string, string> | null>((resolve) => showDialog({ title, fields, action, resolve }));
}

/* Second-step confirmation floating at the pointer (or the button, for keyboard clicks). */
export function confirm(event: Anchor, message: string, action = "删除") {
  const { clientX: x, clientY: y } = point(event);
  return new Promise<boolean>((resolve) => showConfirm({ x, y, message, action, resolve: (v) => resolve(v !== null) }));
}

/* Single text field at the pointer; resolves to the trimmed text, or null when cancelled. */
export function promptAt(event: Anchor, message: string, value: string, action = "确定") {
  const { clientX: x, clientY: y } = point(event);
  return new Promise<string | null>((resolve) => showConfirm({ x, y, message, action, input: value, resolve }));
}

/* Several destructive options at the pointer; resolves to the chosen value, or null. */
export function choose(event: Anchor, message: string, choices: Choice[]) {
  const { clientX: x, clientY: y } = point(event);
  return new Promise<string | null>((resolve) => showConfirm({ x, y, message, action: "", choices, resolve }));
}

/* Pointer position, or the element's corner for keyboard clicks (no coordinates).
   Capture it before any await: React clears currentTarget after the handler returns. */
export function point({ clientX: x, clientY: y, currentTarget }: Anchor): Anchor {
  if (!x && !y && currentTarget instanceof Element) {
    const box = currentTarget.getBoundingClientRect();
    [x, y] = [box.left, box.bottom];
  }
  return { clientX: x, clientY: y, currentTarget: null };
}

export function Dialogs() {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const [pending, setPending] = useState<ConfirmRequest | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [text, setText] = useState("");
  useEffect(() => {
    showDialog = (r) => {
      setRequest(r);
      setValues(Object.fromEntries(r.fields.map((f) => [f.key, f.value ?? f.options?.[0]?.value ?? ""])));
    };
    showConfirm = (r) => {
      setText(r.input ?? "");
      setPending((old) => {
        old?.resolve(null);
        return r;
      });
    };
  }, []);
  const close = (result: Record<string, string> | null) => {
    request?.resolve(result);
    setRequest(null);
  };
  const settle = (ok: boolean) => {
    pending?.resolve(ok ? text.trim() : null);
    setPending(null);
  };
  useEscape(() => close(null), !!request);
  useEscape(() => settle(false), !!pending);

  if (pending?.choices) {
    const width = 300;
    const left = pending.x + width + 12 > innerWidth ? pending.x - width - 6 : pending.x + 6;
    const top = Math.min(pending.y + 6, innerHeight - 60 - pending.choices.length * 56);
    return (
      <div className="fixed inset-0 z-50" onMouseDown={(e) => e.target === e.currentTarget && settle(false)}>
        <div className="card absolute p-2 shadow-xl" style={{ left: Math.max(8, left), top, width }}>
          <p className="px-1.5 pt-1 pb-1.5 text-xs text-muted">{pending.message}</p>
          {pending.choices.map((c, i) => (
            <button
              key={c.value}
              autoFocus={i === 0}
              className="block w-full cursor-pointer rounded-md px-2 py-1.5 text-left hover:bg-danger/10 focus-visible:bg-danger/10 focus-visible:outline-none"
              onClick={() => {
                pending.resolve(c.value);
                setPending(null);
              }}
            >
              <span className="block text-[13px] font-medium text-danger">{c.label}</span>
              {c.hint && <span className="mt-0.5 block text-xs text-muted">{c.hint}</span>}
            </button>
          ))}
          <div className="mt-1 flex justify-end border-t border-line pt-2">
            <button type="button" className="btn btn-sm" onClick={() => settle(false)}>
              取消
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (pending) {
    const prompt = pending.input !== undefined;
    const width = prompt ? 280 : 240;
    const left = pending.x + width + 12 > innerWidth ? pending.x - width - 6 : pending.x + 6;
    const top = Math.min(pending.y + 6, innerHeight - (prompt ? 140 : 110));
    return (
      <div className="fixed inset-0 z-50" onMouseDown={(e) => e.target === e.currentTarget && settle(false)}>
        <form
          className="card absolute p-3 shadow-xl"
          style={{ left: Math.max(8, left), top, width }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!prompt || text.trim()) settle(true);
          }}
        >
          <p className="text-xs leading-relaxed">{pending.message}</p>
          {prompt && <input className="input mt-2" autoFocus value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.currentTarget.select()} />}
          <div className="mt-2.5 flex justify-end gap-1.5">
            <button type="button" className="btn btn-sm" onClick={() => settle(false)}>
              取消
            </button>
            <button
              type="submit"
              autoFocus={!prompt}
              disabled={prompt && !text.trim()}
              className={cx("btn btn-sm", prompt ? "btn-primary" : "border-transparent bg-danger text-white hover:bg-danger hover:brightness-110")}
            >
              {pending.action}
            </button>
          </div>
        </form>
      </div>
    );
  }
  if (!request) return null;
  // Text fields are required; a choice may be empty ("none").
  const ready = request.fields.every((f) => f.options || values[f.key]?.trim());
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/25 p-4 dark:bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && close(null)}>
      <form
        className="card w-full max-w-sm p-5 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) close(values);
        }}
      >
        <h2 className="text-[15px] font-semibold">{request.title}</h2>
        <div className="mt-4 space-y-3">
          {request.fields.map((f, i) => (
            <Field key={f.key} label={f.label}>
              {f.options ? (
                <select className="input" value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="input" autoFocus={i === 0} value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
              )}
            </Field>
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => close(null)}>
            取消
          </button>
          <button type="submit" disabled={!ready} className="btn btn-primary">
            {request.action}
          </button>
        </div>
      </form>
    </div>
  );
}

export function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
  return new Date(iso).toLocaleDateString();
}

/* Title that edits in place: full name, wraps past max width, pencil on hover/focus.
   Saves on blur or Enter; Escape reverts. */
export function NameInput({ value, onSave, label, className }: { value: string; onSave: (name: string) => Promise<boolean>; label: string; className?: string }) {
  const [name, setName] = useState(value);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setName(value), [value]);
  async function commit() {
    const next = name.trim();
    if (!next || next === value || !(await onSave(next))) setName(value);
  }
  return (
    <span className={cx("group inline-flex min-w-0 items-start gap-1", className)}>
      <textarea
        ref={field}
        rows={1}
        aria-label={label}
        className="-ml-1.5 max-w-full min-w-8 resize-none rounded-md border border-transparent bg-transparent px-1.5 font-semibold [overflow-wrap:anywhere] outline-none [field-sizing:content] hover:border-line focus:border-accent/60 focus:ring-3 focus:ring-accent-soft"
        value={name}
        onChange={(e) => setName(e.target.value.replace(/\n/g, ""))}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            setName(value);
            requestAnimationFrame(() => field.current?.blur());
          }
        }}
      />
      <button
        tabIndex={-1}
        aria-label={`修改${label}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => field.current?.focus()}
        className="mt-[0.35em] shrink-0 cursor-pointer text-muted opacity-0 transition-opacity group-focus-within:text-accent group-focus-within:opacity-100 group-hover:opacity-100"
      >
        <Edit2 size={13} />
      </button>
    </span>
  );
}

/* Copy text; the icon turns into a check for a moment. With children: a labelled button. */
export function CopyButton({ text, label = "复制", className, children }: { text: string; label?: string; className?: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // The Clipboard API needs a secure context; plain http over LAN lands here.
      const area = Object.assign(document.createElement("textarea"), { value: text });
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
  }
  if (children)
    return (
      <button className={cx("btn btn-sm", className)} onClick={() => void copy()}>
        {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
        {copied ? "已复制" : children}
      </button>
    );
  return (
    <button className={cx("tip btn btn-ghost btn-sm btn-icon", copied && "text-ok", className)} data-tip={copied ? "已复制" : label} aria-label={label} onClick={() => void copy()}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

/* Centered dialog. `wide`: a large editing surface with a fixed height. Otherwise it fits its
   content and scrolls; `width` replaces the default max-w-md (e.g. "max-w-3xl" for reading). */
export function Modal({ title, onClose, children, actions, footer, wide, width = "max-w-md" }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode; footer?: ReactNode; wide?: boolean; width?: string }) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/25 p-4 dark:bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx("card flex max-h-[calc(100dvh-2rem)] w-full flex-col shadow-2xl", wide ? "h-[88vh] max-w-6xl" : width)}>
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-line pr-2 pl-5">
          <h2 className="min-w-0 truncate text-[15px] font-semibold">{title}</h2>
          <div className="flex items-center gap-0.5">
            {actions}
            <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="关闭">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className={cx("min-h-0 flex-1", wide ? "flex flex-col" : "overflow-y-auto p-5")}>{children}</div>
        {footer && <div className="flex shrink-0 items-center gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export interface Option {
  value: string;
  label: string;
  group?: string;
  /* Small chip after the label, e.g. what produced a generated audio. */
  tag?: string;
}

/* Select with type-to-filter: typing filters (space-separated terms, all must match),
   ↑/↓ move, Enter picks, Escape or blur closes. The list is fixed-positioned so it
   isn't clipped by scrolling sheets. */
export function Combobox({ value, options, onChange, placeholder = "选择…", label, disabled, className }: { value: string | null; options: Option[]; onChange: (value: string) => void; placeholder?: string; label?: string; disabled?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<DOMRect | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === (value ?? ""));
  const shown = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return options.filter((o) => terms.every((t) => `${o.label} ${o.group ?? ""}`.toLowerCase().includes(t)));
  }, [options, query]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  useEscape(close, open);
  function show() {
    if (disabled || open) return;
    setBox(input.current!.getBoundingClientRect());
    setActive(Math.max(0, options.findIndex((o) => o.value === (value ?? ""))));
    setOpen(true);
  }
  function pick(option?: Option) {
    if (!option) return;
    onChange(option.value);
    close();
  }
  // Follow the input while ancestors scroll or the window resizes.
  useEffect(() => {
    if (!open) return;
    const place = () => input.current && setBox(input.current.getBoundingClientRect());
    addEventListener("scroll", place, true);
    addEventListener("resize", place);
    return () => {
      removeEventListener("scroll", place, true);
      removeEventListener("resize", place);
    };
  }, [open]);
  useEffect(() => {
    if (open) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const below = box ? innerHeight - box.bottom : 0;
  const up = !!box && below < 240 && box.top > below;
  return (
    <div className={cx("relative min-w-0", className)}>
      <input
        ref={input}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        disabled={disabled}
        className={cx("input truncate pr-7", !open && !selected && "text-muted")}
        value={open ? query : (selected?.label ?? "")}
        placeholder={open ? selected?.label || "输入以筛选…" : placeholder}
        onClick={show}
        onBlur={close}
        onChange={(e) => {
          show();
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) return show();
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((i) => Math.min(Math.max(i + step, 0), shown.length - 1));
          } else if (e.key === "Enter" && open) {
            e.preventDefault();
            pick(shown[active]);
          } else if (e.key === "Tab") close();
        }}
      />
      <ChevronDown size={14} className="pointer-events-none absolute top-2.5 right-2 text-muted" />
      {open && box && (
        <div
          ref={list}
          role="listbox"
          onMouseDown={(e) => e.preventDefault()}
          className="card fixed z-50 max-h-64 overflow-y-auto py-1 shadow-xl"
          style={{ left: box.left, width: Math.max(box.width, 240), ...(up ? { bottom: innerHeight - box.top + 4 } : { top: box.bottom + 4 }) }}
        >
          {shown.map((o, i) => (
            <div key={o.value}>
              {o.group && o.group !== shown[i - 1]?.group && <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-muted">{o.group}</div>}
              <div
                role="option"
                aria-selected={o.value === (value ?? "")}
                data-index={i}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
                className={cx("flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[13px]", i === active && "bg-hover", o.value === (value ?? "") && "font-medium text-accent")}
              >
                <span className="min-w-0 flex-1 truncate" title={o.label}>
                  {o.label}
                </span>
                {o.tag && <span className="chip shrink-0">{o.tag}</span>}
                {o.value === (value ?? "") && <Check size={13} className="shrink-0" />}
              </div>
            </div>
          ))}
          {!shown.length && <p className="px-2.5 py-2 text-xs text-muted">无匹配</p>}
        </div>
      )}
    </div>
  );
}
