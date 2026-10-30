"""A single worker runs queued tasks in order; concurrent tasks (external API calls, which
batch on the engine's own thread) run beside it. Queue metadata survives restarts."""

from datetime import datetime, timedelta, timezone
from queue import Queue
from time import monotonic
from threading import Condition, Thread
from .storage import now

ACTIVE = {"queued", "running"}
MODEL_TITLES = {"model-load": "加载模型", "model-unload": "卸载模型"}
KEEP = timedelta(days=30)


class Cancelled(Exception):
    pass


class Busy(ValueError):
    """Maps to HTTP 409."""


class Tasks:
    def __init__(self, store):
        self.store = store
        self.queue = Queue()
        self.closed = False
        self.finished = Condition()  # notified when a task reaches a final status
        with store.lock:
            expired = (datetime.now(timezone.utc) - KEEP).isoformat()
            for task in store.list("tasks"):
                if task["status"] not in ACTIVE and task["updated_at"] < expired:
                    store.delete("tasks", task["id"])
                    continue
                changed = not task.get("title") and bool(title := self._fallback_title(task))
                if changed:
                    task["title"] = title
                if task["status"] in ACTIVE:
                    changed = True
                    task.update(
                        status="interrupted", message="服务重启，任务未自动重试"
                    )
                if changed:
                    store.save("tasks", task)
        self.worker = Thread(target=self._run, daemon=True, name="webui-inference")
        self.worker.start()

    def _fallback_title(self, task):
        """Title for records created before tasks had one: session, source audio, then result.
        Old speech records lack the text, so their reference audio is labelled as such."""
        if task["kind"] in MODEL_TITLES:
            return MODEL_TITLES[task["kind"]]
        prefix = "参考音频：" if task["kind"] == "speech" else ""
        for kind, ids, label in (("sessions", task.get("session_ids"), ""), ("audio", task.get("audio_ids"), prefix)):
            try:
                return label + self.store.get(kind, ids[0])["name"]
            except (IndexError, KeyError, TypeError, ValueError):
                pass
        return (task.get("result") or {}).get("name") or ""

    def submit(self, kind, function, session_ids=(), audio_ids=(), title="", line_ids=(), concurrent=False):
        """Queue `function(progress)`; progress(value, desc) raises Cancelled. A `concurrent`
        task runs on its own thread at once instead of waiting for the serial worker (its
        function must do its own GPU coordination, as Engine.synthesize does)."""
        with self.store.lock:
            if self.closed:
                raise ValueError("服务正在停止")
            task = self.store.create(
                "tasks",
                {
                    "kind": kind,
                    "title": title,
                    "status": "queued",
                    "progress": 0,
                    "message": "等待执行",
                    "session_ids": list(session_ids),
                    "audio_ids": list(audio_ids),
                    "line_ids": list(line_ids),
                    "result": None,
                    "error": None,
                    "cancel_requested": False,
                },
            )
            if concurrent:
                Thread(target=self._execute, args=(task["id"], function), daemon=True).start()
            else:
                self.queue.put((task["id"], function))
            return task

    def delete(self, ids=None):
        """Delete finished task records (all when ids is None); active tasks are kept."""
        with self.store.lock:
            records = [t for t in self.store.list("tasks") if ids is None or t["id"] in ids]
            finished = [t["id"] for t in records if t["status"] not in ACTIVE]
            for key in finished:
                self.store.delete("tasks", key)
            return {"deleted": len(finished)}

    def ensure_idle(self, session_ids):
        if any(
            t["status"] in ACTIVE and set(t["session_ids"]) & set(session_ids)
            for t in self.store.list("tasks")
        ):
            raise Busy("该 session 有排队或运行中的任务，请等待完成或取消后操作")

    def active_audio_ids(self):
        return {
            key
            for t in self.store.list("tasks")
            if t["status"] in ACTIVE
            for key in t.get("audio_ids", [])
        }

    def wait(self, key, timeout):
        """Block until the task is no longer queued or running; the record, or None on timeout."""
        deadline = monotonic() + timeout
        with self.finished:
            while (task := self.store.get("tasks", key))["status"] in ACTIVE:
                if (remaining := deadline - monotonic()) <= 0:
                    return None
                self.finished.wait(min(remaining, 1))  # queued tasks cancelled directly skip _finish
            return task

    def cancel(self, key):
        with self.store.lock:
            task = self.store.get("tasks", key)
            if task["status"] in ACTIVE:
                task["cancel_requested"] = True
                if task["status"] == "queued":
                    task["status"] = "cancelled"
                task["message"] = "取消已请求，等待安全边界"
                self.store.save("tasks", task)
            return task

    def progress(self, key, value=None, desc=""):
        with self.store.lock:
            task = self.store.get("tasks", key)
            if task["cancel_requested"]:
                raise Cancelled()
            if value is not None:
                task["progress"] = min(1, max(0, float(value)))
            task["message"] = desc
            self.store.save("tasks", task)

    def _run(self):
        while (item := self.queue.get()) is not None:
            try:
                self._execute(*item)
            finally:
                self.queue.task_done()

    def _execute(self, key, function):
        try:
            with self.store.lock:
                task = self.store.get("tasks", key)
                if task["cancel_requested"]:
                    return
                task.update(status="running", started_at=now())
                self.store.save("tasks", task)
            result = function(
                lambda value=None, desc="": self.progress(key, value, desc)
            )
            self.progress(key, 1, "完成")
            self._finish(key, "succeeded", result=result)
        except Cancelled:
            self._finish(key, "cancelled", message="已取消")
        except Exception as error:
            self._finish(key, "failed", error=str(error), message=str(error))

    def _finish(self, key, status, **fields):
        with self.finished:
            self.store.update("tasks", key, {"status": status, "finished_at": now(), **fields})
            self.finished.notify_all()

    def close(self):
        with self.store.lock:
            self.closed = True
            for task in self.store.list("tasks"):
                if task["status"] in ACTIVE:
                    self.cancel(task["id"])
        self.queue.put(None)
        self.worker.join()
