"""Queue GPU work: speech, subtitles, session takes, merge. Beam work runs on the single
task worker; batch-mode work (and API calls) runs concurrently on the engine's scheduler."""

import os
import tempfile
from pathlib import Path
from .audio import title
from .sessions import current_take, folder


def is_batch(settings):
    return settings.get("mode") == "batch"


class Generation:
    def __init__(self, store, tasks, audio, sessions, engine):
        self.store, self.tasks, self.audio = store, tasks, audio
        self.sessions, self.engine = sessions, engine

    def load_model(self):
        return self.tasks.submit("model-load", self.engine.load, title="加载模型")

    def unload_model(self):
        return self.tasks.submit("model-unload", self.engine.unload, title="卸载模型")

    def speech(self, request):
        return self.speak(request.audio_id, request.text, request.generation.model_dump())

    def speak(self, audio_id, text, settings, kind="speech", label="", deliver=None, batched=False):
        """One sentence into outputs/; `label` prefixes the task title (API calls name their API).
        With `deliver`, nothing is registered: the WAV is a temp file handed to deliver(path),
        which owns it from then on (API calls delete it once sent). `batched` (always for API
        calls, else mode "batch") skips the serial queue and decodes with continuous
        batching (num_beams = best-of-N)."""
        source = self.audio.path(audio_id)
        batched = batched or is_batch(settings)
        infer = self.engine.synthesize if batched else self.engine.infer

        def run(progress):
            if deliver:
                handle, name = tempfile.mkstemp(suffix=".wav")
                os.close(handle)
                path = Path(name)
                try:
                    infer(source, text, path, settings, progress)
                    size = path.stat().st_size
                except BaseException:
                    path.unlink(missing_ok=True)
                    raise
                deliver(path)
                return {"size": size}
            path = self.audio.new_path(".wav", "outputs")
            try:
                infer(source, text, path, settings, progress)
                return self.audio.register(path, title(text))
            except Exception:
                path.unlink(missing_ok=True)
                raise

        name = f"{label} · {text[:60]}" if label else text[:80]
        return self.tasks.submit(kind, run, audio_ids=[audio_id], title=name, concurrent=batched)

    def subtitles(self, request):
        source = self.audio.path(request.audio_id)
        name = self.store.get("audio", request.audio_id)["name"]

        def run(progress):
            path = self.audio.new_path(".srt", "outputs")
            self.engine.subtitles(source, path, request.model, request.language, progress)
            return self.audio.register(path, title(Path(name).stem, 80))

        return self.tasks.submit("subtitles", run, audio_ids=[request.audio_id], title=name)

    def session(self, key, line_id=None):
        with self.store.lock:
            jobs = self.sessions.reserve(key, [line_id] if line_id else None)
            name = self.store.get("sessions", key)["name"]
            title = f"{name} · #{jobs[0]['index']} {jobs[0]['take']['snapshot']['text'][:40]}" if line_id else f"{name} · 全部 {len(jobs)} 句"

            def run_batch(progress):
                """Every line decodes at once; each take is kept as soon as its line finishes."""
                snapshots = [job["take"]["snapshot"] for job in jobs]
                items = [(self.audio.path(s["audio_id"]), s["text"], job["path"], s["generation"]) for s, job in zip(snapshots, jobs)]
                saved = set()

                def keep(index):
                    self.sessions.complete(key, jobs[index])
                    saved.add(index)

                try:
                    self.engine.synthesize_many(items, progress, keep)
                except BaseException:
                    for index, job in enumerate(jobs):
                        if index not in saved:
                            job["path"].unlink(missing_ok=True)
                    raise
                return {"session_id": key, "take_ids": [job["take"]["id"] for job in jobs]}

            def run(progress):
                count = len(jobs)
                for position, job in enumerate(jobs):
                    snapshot = job["take"]["snapshot"]
                    step = lambda value=None, desc="": progress((position + (value or 0)) / count, desc)
                    step(0, f"生成 {position + 1}/{count}")
                    try:
                        self.engine.infer(
                            self.audio.path(snapshot["audio_id"]),
                            snapshot["text"],
                            job["path"],
                            snapshot["generation"],
                            step,
                        )
                        self.sessions.complete(key, job)
                    except Exception:
                        job["path"].unlink(missing_ok=True)
                        raise
                return {"session_id": key, "take_ids": [job["take"]["id"] for job in jobs]}

            audio_ids = [job["take"]["snapshot"]["audio_id"] for job in jobs]
            line_ids = [job["line_id"] for job in jobs]
            # One session generation setting: every snapshot has the same mode.
            if is_batch(jobs[0]["take"]["snapshot"]["generation"]):
                return self.tasks.submit("session-generate", run_batch, [key], audio_ids, title, line_ids, concurrent=True)
            return self.tasks.submit("session-generate", run, [key], audio_ids, title, line_ids)

    def merge(self, key):
        name = self.store.get("sessions", key)["name"]
        return self.tasks.submit("merge", lambda progress: self._merge(key, progress), [key], title=name)

    def _merge(self, key, progress):
        from pydub import AudioSegment

        with self.store.lock:
            session = self.store.get("sessions", key)
            paths = []
            for line in session["lines"]:
                take = current_take(line)
                path = take and self.sessions.take_path(session, line["id"], take)
                if not path or not path.is_file():
                    raise ValueError(f"句子 #{line['index']} 没有当前音频")
                paths.append(path)
        if not paths:
            raise ValueError("没有句子")
        gap = AudioSegment.silent(duration=session["interval"] * 1000)
        combined = AudioSegment.empty()
        for index, path in enumerate(paths):
            progress(index / len(paths), f"合并 {index + 1}/{len(paths)}")
            combined += (gap if index else AudioSegment.empty()) + AudioSegment.from_file(path)
        output = self.audio.new_path(".wav", f"{folder(key)}/merged")
        combined.export(output, format="wav")
        record = self.audio.register(output, title(session["name"], 80))
        self.sessions.add_output(key, record["id"])
        return record
