"""Roles and multi-speaker presets. A role's reference audio is whatever samples/<name>/
holds, managed in the file system. Anonymous roles, and bindings without a role, may use
any audio."""

from .audio import SAMPLES


class Library:
    def __init__(self, store, audio):
        self.store, self.audio = store, audio

    def bindings_of(self, role_id):
        for entry in self.store.list("sessions") + self.store.list("presets"):
            for binding in entry["bindings"]:
                if binding.get("role_id") == role_id:
                    yield binding

    def view(self, role):
        """Role as the API returns it, with the audio currently in its folder."""
        return {**role, "audio_ids": self.audio.folder(role["name"])}

    def validate_bindings(self, bindings):
        names = [b.speaker for b in bindings]
        if len(names) != len(set(names)):
            raise ValueError("说话人名称不能重复")
        for binding in bindings:
            if binding.role_id:
                role = self.store.get("roles", binding.role_id)
                if binding.audio_id and not role["anonymous"] and binding.audio_id not in self.audio.folder(role["name"]):
                    raise ValueError(f"参考音频不在 samples/{role['name']}/ 中")
            if binding.audio_id:
                self.audio.path(binding.audio_id)

    def rebind_plan(self, key, request):
        """Bound audio this role keeps under the requested name and mark.

        Anonymous roles accept any audio: nothing to do. Otherwise every audio the role's
        bindings use must be in samples/<new name>/; after a rename, a file moved along with
        its folder (same relative path) is mapped old id -> new id. Raises if any is missing.
        API voices in the old folder are mapped too when their file moved, but never block."""
        old = self.store.get("roles", key)["name"]
        root = (SAMPLES / request.name).resolve()

        def moved(audio_id):
            record = self.store.get("audio", audio_id)
            inside = record.get("source") == "samples" and record["path"].startswith(old + "/")
            target = (root / record["path"][len(old) + 1 :]).resolve() if inside else None
            return self.audio.sample(target)["id"] if target and target.is_relative_to(root) and target.is_file() else None

        mapping, missing = {}, []
        if old != request.name:
            for api in self.store.list("apis"):
                for voice in api["voices"]:
                    if voice["audio_id"] not in mapping and (target := moved(voice["audio_id"])):
                        mapping[voice["audio_id"]] = target
        if request.anonymous:
            return mapping
        folder = set(self.audio.folder(request.name))
        for binding in self.bindings_of(key):
            audio_id = binding.get("audio_id")
            if not audio_id or audio_id in folder or audio_id in mapping:
                continue
            if target := moved(audio_id):
                mapping[audio_id] = target
            else:
                missing.append(self.store.get("audio", audio_id)["name"])
        if missing:
            raise ValueError(
                f"samples/{request.name}/ 中缺少 {len(set(missing))} 个已绑定的音频（如 {missing[0]}）。"
                "请先把文件放进该文件夹、更换相关绑定，或将角色标记为匿名"
            )
        return mapping

    def save_role(self, request, key=None):
        with self.store.lock:
            if key is None:
                return self.store.create("roles", request.model_dump())
            return self.store.update("roles", key, request.model_dump())

    def delete_role(self, key):
        with self.store.lock:
            if any(True for _ in self.bindings_of(key)):
                raise ValueError("角色仍被 session 或预设引用")
            self.store.delete("roles", key)

    def save_preset(self, request, key=None):
        with self.store.lock:
            self.validate_bindings(request.bindings)
            if key is None:
                return self.store.create("presets", request.model_dump())
            return self.store.update("presets", key, request.model_dump())
