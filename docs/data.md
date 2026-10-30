# Data Directory

All WebUI state lives in `data/` at the repository root (override with the `WEBUI3_DATA` environment variable). It holds only what the backend reads: no backups, logs or caches. Reference audio is **not** here: it stays in `samples/`, which the user manages and the app only reads.

```text
data/
  projects/<project_id>.json                 project record (a name; no folder)
  sessions/<session_id>.json                 session record
  sessions/<session_id>/                     that session's audio
    takes/<line_id>/<take_index>_<take_id>.wav   generated takes, one folder per line
    merged/<id>.wav                          merge results
  roles/<role_id>.json                       role record
  presets/<preset_id>.json                   multi-speaker preset record
  apis/<api_id>.json                         external TTS API record (/tts/<slug>)
  audio/<audio_id>.json                      audio record for non-take audio (no audio in this folder)
  audio/files/<id>.<ext>                     uploaded reference audio
  outputs/<id>.wav | <id>.srt                语音生成 / 字幕生成 results
  tasks/<task_id>.json                       task record (queue state and history)
```

Every record file is `<kind>/<id>.json` with `id`, `schema_version`, `created_at`, `updated_at` (UTC ISO 8601) and is written atomically (temp file + replace). Ids are 32-hex uuids, except samples audio (`sample-<hash>`, see below).

## Records

### `projects/<id>.json`

```json
{ "name": "婚姻调节室-章节", "id": "…", "schema_version": 1, "created_at": "…", "updated_at": "…" }
```

A project's sessions are the session records whose `project_id` matches; a project has no folder. Deleting a project deletes its sessions with their audio.

### `sessions/<id>.json`

```json
{
  "name": "05-01",
  "project_id": "…" | null,
  "bindings": [{ "speaker": "卡维", "role_id": "…" | null, "audio_id": "…" | null }],
  "generation": { "mode": "normal" | "fast" | "batch", "top_p": 0.8, "…": "…" },
  "interval": 0.5,
  "lines": [Line, …],
  "next_index": 52,
  "text": "[卡维] …\n[旁白] …",
  "outputs": ["<audio_id of a merge>", …],
  "id": "…", "schema_version": 1, "created_at": "…", "updated_at": "…"
}
```

- `project_id`: the project it belongs to, or `null` for none. Changing it moves no files.
- `bindings`: speaker name in the text → role and reference audio. `role_id: null` means no role (any audio).
- `generation`: inference parameters used for new takes.
- `lines`: in display / merge order.
- `next_index`: the next line index to hand out; indexes are never reused.
- `text`: the lines as `[speaker] text`, derived on every save (read-only convenience).
- `outputs`: merge results, oldest first.

The session's audio lives in `sessions/<id>/`, beside its record.

**Line**

```json
{
  "id": "…", "index": 35, "speaker": "卡维", "text": "…",
  "takes": [Take, …], "current_take_id": "…" | null, "next_take_index": 3,
  "revision": 2, "selection_revision": 1
}
```

- `index`: stable identity shown as `#35`, never reused. Order is the position in `lines`, not the index.
- `next_take_index`: Take numbers only grow, even after cleanup.
- `revision` / `selection_revision`: bumped by text edits / manual take selection. A generation that finishes after either changed does not take over the current Take.

**Take**

```json
{
  "id": "…", "take_index": 2, "created_at": "…",
  "snapshot": { "text": "…", "speaker": "卡维", "audio_id": "<reference audio>", "generation": { … } }
}
```

`snapshot` is what the take was generated from (`snapshot.audio_id` is the reference audio); when it differs from the line's current text, binding or parameters, the UI marks the take as stale.

A take has **no audio record**: its file is derived as `sessions/<session_id>/takes/<line_id>/<take_index>_<take_id>.wav` and served by `GET /api/sessions/{s}/lines/{l}/takes/{t}/file`.

### `roles/<id>.json`

```json
{ "name": "卡维", "tags": [], "anonymous": false, "id": "…", … }
```

No audio is stored. The API adds `audio_ids`: the files currently under `samples/<name>/` (recursive). `anonymous: true` (旁白, 路人…) lets bindings use any audio.

### `presets/<id>.json`

```json
{ "name": "路人局", "bindings": [Binding, …], "generation": { … }, "id": "…", … }
```

Same `bindings` / `generation` shapes as a session; copied into a session when it is created from the preset.

### `apis/<id>.json`

```json
{
  "name": "直播读弹幕", "slug": "live", "access": "public" | "private", "enabled": true,
  "token": "…" | null,
  "voices": [{ "name": "kaveh", "audio_id": "sample-…" }],
  "generation": { … },
  "id": "…", …
}
```

- `slug`: the endpoint is `/tts/<slug>` (case-insensitive, unique).
- `token`: generated the first time the API is private; kept when switching to public and back. Only checked for private APIs.
- `voices`: saved voice names callers pass as `voice`; reference audio only (samples or uploads). A call may also name any reference audio by id or samples path, so this list is a convenience, not a whitelist. Renaming a role re-points voices whose file moved with its folder.
- `generation`: defaults; a POST may override fields in its own `generation`.

API calls are `api` tasks whose `result` is just `{ "size": <bytes> }`: the audio is a temp file deleted right after the response is sent (no audio record, nothing kept); each call is logged to the server console.

### `audio/<id>.json`

One record per audio file other than takes (references, uploads, outputs, merges); bindings, snapshots, tasks and session `outputs` point to audio by this id.

```json
{ "name": "Take 验证示例", "path": "sessions/…/merged/….wav", "size": 157740, "id": "…", … }
{ "name": "卡维/0 正常.wav", "path": "卡维/0 正常.wav", "source": "samples", "size": 651692, "id": "sample-…", … }
```

- `path`: relative to `data/`, or to `samples/` when `source` is `"samples"`.
- `name`: for files from disk (samples, uploads) the file name; for generated audio a display name without extension. Downloads use `name` plus the file's real suffix.
- samples records are created on first use (role folder listing, picking a samples file). Their id is a hash of the relative path, so the same file always has the same id; a renamed or moved file gets a new one.

| Kind | `path` | Typical name |
|---|---|---|
| Merge | `sessions/<s>/merged/<id>.wav` | session name |
| 语音生成 / 字幕 output | `outputs/<id>.wav` / `.srt` | first words of the text / source name |
| Upload | `audio/files/<id>.<ext>` | original file name |
| samples file | `<relative path in samples/>` (`source: "samples"`) | relative path |

An upload identical to an existing upload or samples file is not stored; the existing record is returned.

### `tasks/<id>.json`

```json
{
  "kind": "speech" | "api" | "subtitles" | "session-generate" | "merge" | "model-load" | "model-unload",
  "title": "…", "status": "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted",
  "progress": 1, "message": "完成", "error": null, "cancel_requested": false,
  "session_ids": ["…"], "line_ids": ["…"], "audio_ids": ["<inputs>"], "result": { audio record } | null,
  "started_at": "…", "finished_at": "…", "id": "…", …
}
```

`audio_ids` are the task's inputs (protected from cleanup while it is active); `result` is a copy of the output's audio record (the API substitutes the current record). Queued/running tasks become `interrupted` on restart; finished records older than 30 days are removed at startup, or earlier from the task panel.

## Lifecycle of files

| Created by | Removed by |
|---|---|
| Takes: line / session generation | Cleanup (non-current takes; or take folders of lines removed via 台本), session or project deletion, deleting lines (single or multi-select) |
| Merges: 合并 | Session or project deletion |
| `outputs/`: 语音生成, 字幕生成 | Not removed automatically |
| `audio/files/`: upload | Not removed automatically |
| samples records: first use | Never; the files belong to `samples/` and are never touched |

Protected from every deletion: current takes, reference audio used by a binding or take snapshot, and inputs of queued or running tasks. Take cleanup is refused while the session has a queued or running task.

## Legacy fields

Records imported from webui2 carry provenance fields that nothing reads: `session.migration` (`source`, `source_modified_at`, `review_required`) and `take.source_audio_path`. They can be dropped with the server stopped.
