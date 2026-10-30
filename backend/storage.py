"""Atomic JSON records; callers hold the shared lock across read/modify/write."""

import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from uuid import uuid4

KINDS = {"roles", "presets", "projects", "sessions", "audio", "tasks", "apis"}


def now():
    return datetime.now(timezone.utc).isoformat()


def uid():
    return uuid4().hex


def replace(source, target, attempts=20):
    """os.replace, retried: on Windows antivirus/indexers briefly lock fresh files (WinError 5)."""
    for attempt in range(attempts):
        try:
            return source.replace(target)
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(0.02 * (attempt + 1))


class Store:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()

    def path(self, relative):
        path = (self.root / relative).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError("资源路径超出 data 目录")
        return path

    def relative(self, path):
        return Path(path).resolve().relative_to(self.root).as_posix()

    def record_path(self, kind, key):
        if kind not in KINDS:
            raise ValueError("未知资源类型")
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", key):
            raise ValueError("无效资源 ID")
        return self.path(f"{kind}/{key}.json")

    def get(self, kind, key):
        with self.lock:
            path = self.record_path(kind, key)
            if not path.exists():
                raise KeyError(f"{kind}/{key} 不存在")
            return json.loads(path.read_text(encoding="utf-8"))

    def list(self, kind, newest=False):
        with self.lock:
            records = [
                json.loads(p.read_text(encoding="utf-8"))
                for p in self.path(kind).glob("*.json")
            ]
        if newest:
            records.sort(key=lambda r: r["created_at"], reverse=True)
        return records

    def write_json(self, path, data):
        path = self.path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + f".{uid()}.tmp")
        try:
            temporary.write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def save(self, kind, record, touch=True):
        """touch=False keeps updated_at: for consistency fixes that aren't user edits."""
        with self.lock:
            if touch:
                record["updated_at"] = now()
            self.write_json(self.record_path(kind, record["id"]), record)
            return record

    def create(self, kind, fields, key=None):
        with self.lock:
            record = {
                **fields,
                "id": key or uid(),
                "schema_version": 1,
                "created_at": now(),
                "updated_at": now(),
            }
            if self.record_path(kind, record["id"]).exists():
                raise ValueError("资源已存在")
            return self.save(kind, record)

    def update(self, kind, key, fields):
        with self.lock:
            record = self.get(kind, key)
            record.update(fields)
            return self.save(kind, record)

    def delete(self, kind, key):
        with self.lock:
            self.get(kind, key)
            self.record_path(kind, key).unlink()
