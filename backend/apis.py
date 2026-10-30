"""External TTS endpoints (/tts/<slug>). Each API record holds its access mode, token,
default generation parameters and saved voices; a call may still name any reference audio."""

import logging
import secrets
from threading import Lock
from time import monotonic
from . import schemas as S

log = logging.getLogger("uvicorn.error")  # shown in the server console with uvicorn's config

# A call waits this long for its queued job (other work may be ahead) before giving up.
WAIT = 600


class Denied(Exception):
    """Refused call; app maps it to `status`."""

    def __init__(self, status, detail, headers=None):
        super().__init__(detail)
        self.status, self.detail, self.headers = status, detail, headers


def is_reference(record):
    """Reference audio: samples files and uploads, not generated outputs."""
    return record.get("source") == "samples" or record["path"].startswith("audio/files/")


class Handoff:
    """The worker's temp WAV for one waiting request. If the request already gave up, the
    file is deleted on arrival; otherwise the response deletes it once sent."""

    def __init__(self):
        self.lock, self.path, self.abandoned = Lock(), None, False

    def deliver(self, path):
        with self.lock:
            if self.abandoned:
                path.unlink(missing_ok=True)
            else:
                self.path = path

    def abandon(self):
        with self.lock:
            self.abandoned = True
            if self.path:
                self.path.unlink(missing_ok=True)
                self.path = None


class Apis:
    def __init__(self, store, audio, tasks, generation):
        self.store, self.audio, self.tasks, self.generation = store, audio, tasks, generation

    def save(self, request, key=None):
        with self.store.lock:
            others = [a for a in self.store.list("apis") if a["id"] != key]
            if any(a["slug"].lower() == request.slug.lower() for a in others):
                raise ValueError(f"路径 /tts/{request.slug} 已被其他 API 使用")
            names = [v.name for v in request.voices]
            if len(names) != len(set(names)):
                raise ValueError("音色名称不能重复")
            for voice in request.voices:
                if not is_reference(self.store.get("audio", voice.audio_id)):
                    raise ValueError(f"音色「{voice.name}」不是参考音频")
            fields = request.model_dump()
            if key is None:
                return self.store.create("apis", {**fields, "token": self._token(request.access)})
            api = self.store.get("apis", key)
            # Keep the token across public/private switches so a client can be re-enabled.
            api.update(fields, token=api.get("token") or self._token(request.access))
            return self.store.save("apis", api)

    def _token(self, access):
        return secrets.token_urlsafe(24) if access == "private" else None

    def regenerate_token(self, key):
        return self.store.update("apis", key, {"token": secrets.token_urlsafe(24)})

    def find(self, slug, method, authorization, listing=False):
        """The enabled API at /tts/<slug>, if this call may use it. Private synthesis is POST
        only; the read-only voice listing (`listing`) may be GET, still with the token."""
        api = next((a for a in self.store.list("apis") if a["slug"].lower() == slug.lower()), None)
        if not api or not api["enabled"]:
            raise Denied(404, "API 不存在或已停用")
        if api["access"] == "private":
            if method != "POST" and not listing:
                raise Denied(405, "私有 API 仅支持 POST", {"Allow": "POST"})
            scheme, _, token = (authorization or "").partition(" ")
            if scheme.lower() != "bearer" or not api.get("token") or not secrets.compare_digest(token.strip(), api["token"]):
                raise Denied(401, "缺少或错误的 token", {"WWW-Authenticate": "Bearer"})
        return api

    def voices(self, api):
        """Every value `voice` accepts: saved names, samples paths, upload ids."""
        names = {r["id"]: r["name"] for r in self.store.list("audio")}
        uploads = [r for r in self.store.list("audio", newest=True) if r["path"].startswith("audio/files/")]
        return {
            "saved": [{"voice": v["name"], "audio": names.get(v["audio_id"])} for v in api["voices"]],
            "samples": [s["path"] for s in self.audio.sources()],
            "uploads": [{"voice": r["id"], "name": r["name"]} for r in uploads],
        }

    def resolve(self, api, voice):
        """Audio id for `voice`: a saved voice name, else any reference audio by id or by its
        path in samples/."""
        saved = next((v for v in api["voices"] if v["name"] == voice), None)
        if saved:
            return saved["audio_id"]
        try:
            record = self.store.get("audio", voice)
            if is_reference(record):
                return record["id"]
        except (KeyError, ValueError):
            pass
        try:
            return self.audio.import_source(voice)["id"]
        except ValueError:
            raise KeyError(f"未知音色：{voice}（可用已保存的音色名、参考音频 id 或 samples 内的相对路径）") from None

    def synthesize(self, api, text, voice, overrides=None):
        """Queue one sentence and wait for it: (finished task or None on timeout, temp WAV path
        or None). Nothing is registered or kept; the caller deletes the file once sent."""
        settings = S.Generation(**{**api["generation"], **(overrides or {})}).model_dump()
        handoff, start = Handoff(), monotonic()
        task = self.generation.speak(self.resolve(api, voice), text, settings, "api", api["name"], handoff.deliver)
        finished = self.tasks.wait(task["id"], WAIT)
        if finished is None:
            self.tasks.cancel(task["id"])
        if not finished or finished["status"] != "succeeded":
            handoff.abandon()
        status = finished["status"] if finished else "timeout"
        size = ((finished or {}).get("result") or {}).get("size", 0)
        log.info("TTS API %s · voice=%s · %d 字 · %s · %d bytes · %.1fs · %s", api["slug"], voice, len(text), status, size, monotonic() - start, text[:40])
        return finished, handoff.path
