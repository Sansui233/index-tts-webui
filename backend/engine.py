"""Lazy inference adapters for IndexTTS and local Whisper.

Two inference paths share one loaded model: `infer` (the original decoder, beam search,
called by the serial task worker) and `synthesize` (continuous batching on its own
thread, used by the external API). Both hold the gate shared; load, unload and Whisper
hold it exclusively, so they wait until both paths are idle."""

import gc
import subprocess
import wave
from contextlib import contextmanager
from threading import Condition, Thread
from .config import ROOT

WHISPER_MODELS = ("tiny", "base", "small", "medium")
# Old JSON may store whole-number floats as ints; transformers 4.36 needs floats.
FLOAT_OPTIONS = ("top_p", "temperature", "length_penalty", "repetition_penalty")
# Decode rows the batching scheduler runs at once (best-of-N uses N). On an 8 GB RTX 4060,
# 24 rows (8 sentences x best-of-3) step about as fast as 4 and peak near 2.6 GiB.
BATCH_ROWS = 24
POLL = 0.5  # seconds between progress reports (and cancel checks) of a waiting call


def whisper_path(model):
    return ROOT / "checkpoints/whisper" / f"whisper-{model}"


def free_cuda():
    gc.collect()
    import torch

    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def srt_time(seconds):
    ms = max(0, round(float(seconds) * 1000))
    return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"


def to_srt(chunks, duration):
    from opencc import OpenCC

    convert = OpenCC("t2s")
    blocks = []
    for number, chunk in enumerate(chunks, 1):
        start, end = chunk["timestamp"]
        end = duration if end is None else end
        text = convert.convert(chunk["text"].strip())
        blocks.append(f"{number}\n{srt_time(start or 0)} --> {srt_time(end)}\n{text}\n")
    return "\n".join(blocks)


class Gate:
    """Shared/exclusive lock. A waiting exclusive holder blocks new shared ones."""

    def __init__(self):
        self.changed = Condition()
        self.readers = self.waiting = 0
        self.writer = False

    @contextmanager
    def shared(self):
        with self.changed:
            while self.writer or self.waiting:
                self.changed.wait()
            self.readers += 1
        try:
            yield
        finally:
            with self.changed:
                self.readers -= 1
                self.changed.notify_all()

    @contextmanager
    def exclusive(self):
        with self.changed:
            self.waiting += 1
            while self.writer or self.readers:
                self.changed.wait()
            self.waiting -= 1
            self.writer = True
        try:
            yield
        finally:
            with self.changed:
                self.writer = False
                self.changed.notify_all()


class Engine:
    def __init__(self):
        self.tts = None
        self.state = "unloaded"
        self.error = None
        self.gate = Gate()
        self.scheduler = None  # indextts.batch.Scheduler of the loaded model
        self.pending = []  # batch jobs not yet handed to the scheduler
        self.arrived = Condition()
        self.server = None

    def status(self):
        return {"state": self.state, "error": self.error}

    def load(self, progress=None):
        if self.tts is not None:
            return self.status()
        with self.gate.exclusive():
            if self.tts is not None:
                return self.status()
            self.state, self.error = "loading", None
            try:
                if progress:
                    progress(0.02, "加载 IndexTTS")
                from indextts.infer import IndexTTS

                self.tts = IndexTTS(
                    model_dir=str(ROOT / "checkpoints"),
                    cfg_path=str(ROOT / "checkpoints/config.yaml"),
                    use_cuda_kernel=False,
                )
                self.state = "loaded"
            except Exception as error:
                self.tts = None
                self.state, self.error = "error", str(error)
                raise
            return self.status()

    def unload(self, progress=None):
        with self.gate.exclusive():
            return self._drop()

    def _drop(self):
        self.state = "unloading"
        self.tts = self.scheduler = None
        free_cuda()
        self.state, self.error = "unloaded", None
        return self.status()

    @contextmanager
    def _loaded(self, progress=None):
        """Hold the gate shared with the model loaded (loading it first if needed)."""
        while True:
            self.load(progress)
            with self.gate.shared():
                if self.tts is not None:
                    yield
                    return

    def infer(self, source, text, output, settings, progress):
        """Original decoder: one call at a time, from the serial task worker."""
        with self._loaded(progress):
            options = dict(settings)
            for name in FLOAT_OPTIONS:
                options[name] = float(options[name])
            options["top_k"] = options["top_k"] or None
            fast = options.pop("mode") == "fast"
            if not fast:
                options.pop("sentences_bucket_max_size", None)
            self.tts.gr_progress = progress
            try:
                method = self.tts.infer_fast if fast else self.tts.infer
                method(str(source), text, str(output), **options)
            finally:
                self.tts.gr_progress = None

    def synthesize(self, source, text, output, settings, progress):
        """Batched decoder for one text; returns when `output` is written."""
        self.synthesize_many([(source, text, output, settings)], progress)

    def synthesize_many(self, items, progress, saved=None):
        """Batched decoder: `items` of (source, text, output, settings) decode together, and
        with any other caller's. Each output is written, then `saved(index)` called, as soon
        as its text finishes. `num_beams` means best-of-N. The first failure, or a Cancelled
        raised by `progress`, drops the remaining jobs and propagates."""
        import torch
        import torchaudio
        from indextts.batch import Job, SAMPLE_RATE

        jobs = [Job(source, text, settings) for source, text, _, settings in items]
        with self.arrived:
            if self.server is None:
                self.server = Thread(target=self._serve, daemon=True, name="webui-batch")
                self.server.start()
            self.pending += jobs
            self.arrived.notify()
        waiting = list(range(len(jobs)))
        try:
            while waiting:
                for index in [i for i in waiting if jobs[i].done.is_set()]:
                    waiting.remove(index)
                    job = jobs[index]
                    if job.error:
                        raise job.error
                    torchaudio.save(str(items[index][2]), job.wav.type(torch.int16), SAMPLE_RATE)
                    job.wav = None
                    if saved:
                        saved(index)
                if waiting:
                    jobs[waiting[0]].done.wait(POLL)
                    done = len(jobs) - len(waiting)
                    progress(sum(j.progress() for j in jobs) / len(jobs), f"生成 {done}/{len(jobs)}")
        except BaseException:
            for job in jobs:
                job.cancelled = True  # the scheduler drops their rows on the next step
            raise

    def _serve(self):
        """Batching thread: holds the gate shared while it has rows; stops taking new jobs
        when load/unload/Whisper waits, so they run once the current rows finish."""
        from indextts.batch import Scheduler

        while True:
            with self.arrived:
                while not self.pending:
                    self.arrived.wait()
            try:
                with self._loaded():
                    if self.scheduler is None:
                        self.scheduler = Scheduler(self.tts, BATCH_ROWS)
                    scheduler = self.scheduler
                    while True:
                        if not self.gate.waiting:
                            with self.arrived:
                                jobs, self.pending = self.pending, []
                            for job in jobs:
                                try:
                                    scheduler.submit(job)
                                except Exception as error:  # e.g. text the tokenizer rejects
                                    job.fail(error)
                        if not scheduler.busy():
                            break
                        scheduler.step()
            except Exception as error:
                with self.arrived:
                    jobs, self.pending = self.pending, []
                for job in jobs:
                    job.fail(error)
                if self.scheduler:
                    self.scheduler.fail_all(error)
                free_cuda()

    def subtitles(self, source, output, model, language, progress):
        # Never keep both models on the GPU: Whisper runs with the gate exclusive.
        with self.gate.exclusive():
            if self.tts is not None:
                self._drop()
            self._transcribe(source, output, model, language, progress)

    def _transcribe(self, source, output, model, language, progress):
        path = whisper_path(model)
        if not (path / "config.json").exists():
            raise ValueError(f"缺少本地 Whisper 模型：{path}")
        import torch
        from transformers import pipeline

        temporary = output.with_suffix(".input.wav")
        recognizer = None
        try:
            progress(0.1, "转换音频")
            command = ["ffmpeg", "-y", "-i", str(source), "-ac", "1", "-ar", "16000"]
            subprocess.run([*command, str(temporary)], check=True, capture_output=True)
            with wave.open(str(temporary), "rb") as wav:
                duration = wav.getnframes() / wav.getframerate()
            progress(0.2, "加载 Whisper")
            recognizer = pipeline(
                "automatic-speech-recognition",
                model=str(path),
                device=0 if torch.cuda.is_available() else -1,
            )
            progress(0.3, "识别字幕")
            result = recognizer(
                str(temporary),
                return_timestamps=True,
                generate_kwargs={
                    "task": "transcribe",
                    "language": language,
                    "max_new_tokens": 450,
                    "num_beams": 5,
                },
                chunk_length_s=30,
                stride_length_s=[6, 3],
                batch_size=1,
            )
            output.write_text(to_srt(result["chunks"], duration), encoding="utf-8")
        finally:
            temporary.unlink(missing_ok=True)
            del recognizer
            free_cuda()
