# WebUI3 验证记录

日期：2026-09-23。

## 已完成

- 前端 TypeScript 检查及 Vite production build 通过。
- 后端 Ruff 检查通过。
- 7 个针对性 unittest 通过：迁移复制与重复运行、三级 Take 清理与编号递增、失败后重生成、生成期间清理冲突及文本编辑、文件删除失败后重试、其他引用保护、输入和路径验证。
- 实际迁移 27 个 session、7 个多人预设、2,120 个旧 Take；迁移记录中的音频全部找到并复制到新 data 目录。19 个角色绑定使用推导/默认值，需用户核验。
- 迁移后验证源 JSON 与保留快照一致、句子 index 唯一、当前 Take 引用有效、音频资源位于新目录且文件存在；无校验失败。
- 真正的 IndexTTS 短句推理通过，输出 WAV。发现并修复 Transformers 4.36 对 penalty 参数 float 类型的要求。
- 真正的 session API 流程通过：同一句生成 Take 1、Take 2 → 默认选择 Take 2 → 手动选择 Take 1 → 合并输出 2.56 秒音频 → Whisper base 生成 SRT → 模型 unload，最终状态 unloaded。
- 保留“功能验证 / Take 验证示例”，有两个 Take，可直接在 UI 中检查试听和选择。

## 未验证及限制

- CUA 返回没有可用浏览器，尝试 in-app browser 也不可用。未进行实际浏览器点击、截图视觉检查或听感检查；build/API 成功不代表这些检查已完成。
- Python 环境通过 WebUI3 venv 复用指定 conda 环境，未改动其 Torch。API 直接依赖版本记录在 pyproject.toml。尝试生成 uv lock 时 registry 返回 403/包不可用，未生成 Python lockfile；启动使用已验证的现有环境，不自动同步依赖。
- 旧数据的角色音色与项目归属仍需人工核验；UI 可修改角色绑定、名称、项目归属和句子。
- 取消在安全边界执行；已经进入模型的 CUDA 调用不能立即终止。生成和清理不跨进程并行，backend 仅允许单 worker。

## 本机详细记录

- `webui3/data/migrations/outputs.json`：源到目标的映射、默认字段、缺失资源报告。
- `webui3/data/migrations/verification.json`：迁移后的索引与文件校验。
- `webui3/data/migrations/live-verification.json`：真实 API 测试生成的项目/session/task ID、合并时长、字幕和卸载结果。

新数据均在 `webui3/data`，旧 outputs 未迁移删除或覆盖。已有根目录及 webui2 工作区修改保持不变。

## 2026-10-31 并发推理（continuous batching）

- 一致性（`uv run scripts/bench_batch.py`）：贪心解码下，`indextts/batch.py` 与原 `inference_speech` 逐 token 一致：单句 8 组（2 音色 × 4 句），混批 4 句（不同音色、不同长度、第 20 步中途加入）。
- 吞吐（RTX 4060 Laptop 8GB，同机另有进程占约 3GB；采样，24 行）：8 句并发 best-of-3 用 7.73 秒，原路径 beam 3 串行 22.76 秒；显存峰值 2.58 GiB（含权重约 1.9 GiB）。
- 端到端（临时数据目录）：旧路径 speech 任务运行中并发 4 个 API 调用，短句 1.7 秒先返回，旧任务同时完成；取消 0.1 秒生效；卸载等调度器空闲后执行，之后 API 自动重新加载。同一 8 句台本：普通推理 25.9 秒，并发推理 9.6 秒，8 个 take 全部保存。
- 后端 27 个 unittest、前端类型检查与 build 通过。
- 未验证：beam、纯采样、best-of-3 的听感对比。
