This is index tts web ui development directory.

# Project

Index tts webui (formerly webui3), now the repository root project. backend/ (FastAPI), frontend/ (React), indextts/ (inference). See README.md.

# Env
- python: uv project at repo root, Python 3.12 (`uv sync`, `uv run main.py`). Do not use the old conda env.
- torch: 2.8.0+cu128 from the pytorch-cu128 index; uv cache is on F: (hardlink install)
- node: pnpm

# Context

之前开发了 webui2 目录作为新的 webUI 目录，但是存在诸多不足。我现在让你迁移至前后端分离的架构。
- 前端使用 React
- 后端使用 python 暴露推理 API

# 前后端接口分析

1. 你需要分析 index tts 推理 API。 gradio 的接口不够高效，有许多用不到的地方，你需要自己暴露推理相关接口
  a. AI 推理相关
    - 实现语音生成接口。使用 Get 或 Post 进行单句语音生成 Task。推理代码你需要分析如何简洁有效
    - 实现模型 load，unload、load 状态接口。因为显存不够可能要手动 unload。但生成语音时自动 load。避免重复 load 或循环。
  b. 项目管理相关
    - 实现 Task 管理器接口，返回 JSON，以查看正在进行中的任务进度。前端使用 websocket 长连接还是 定时轮询，需要你分析后定
    - 实现角色预设接口。需要实现角色的增、删、list 、改，角色音频的增、删、list、改。
      - 角色：名称、参考音频 Set，标签
      - 使用 Json 存储
    - 实现多人对话的配置预设接口。只需要读取、list、保存接口。
      - 多人对话中的每个角色指定名称和对应的某个参考音频
    - 实现有声书项目接口
      - 一个项目包含多个生成的 session。
      - 一个 session 包含一组角色预设、有声书文本、文本对应的 output。
      - session 有声书文本格式见 webui2 中的定义，需要对应的增删查改的接口。现在 session 的缓存文件读取都  output 目录中，你可以沿用此设计。
  c. 其他的你看看 webui2 目录补充，细节我也忘了一些
  d. 外部 TTS API（已实现，侧栏「API」）
    - 每个 API：`/tts/<slug>`，公开（GET / POST，无认证）或私有（仅 POST + `Authorization: Bearer <token>`），默认推理参数，可停用。
    - `voice` 可用 API 中保存的音色名，也可用服务器上任意参考音频（id 或 samples 相对路径）；`GET /tts/<slug>/voices` 列出可用值。保存的音色只是快捷方式，不是白名单。
    - API 生成的音频不保存：临时文件发送后即删除，不建 audio 记录；每次调用打印日志。
    - POST 接受 JSON，也接受表单 / URL 参数（听书软件只能这样发送）。
    - API 总是走 `indextts/batch.py` 的逐步调度（continuous batching，网页上的「并发推理」模式 `mode: "batch"` 同此），不进串行任务队列，与旧 beam 路径并行；`num_beams` 在此表示 best-of-N。`backend/engine.py` 的 `Gate` 读写锁：两条推理路径共享，加载/卸载/字幕独占。一致性与吞吐：`uv run scripts/bench_batch.py`。
    - 听书配置：把保存的音色生成为 阅读（legado）、服务端阅读（hectorqin/reader，同 legado 格式）、爱阅记 的朗读引擎配置，格式参考 yy4382/tts-importer（`backend/profiles.py`）；支持网络导入 `/tts/<slug>/profile/<app>`。

2. 界面设计

你主要负责 大 frame 的设计，后续我会具体装修

- 简洁清爽的风格，参考 notion。淡蓝色主题色。
- 预定日间模式夜间模式两套颜色。
- 双栏设计，左边为 sidebar，右边为 main
  - 左边非常灵活，实际上有两级。
    - 一级菜单层级就像
```
- 语音生成：点击此按钮，右边是单句生成的 UI
- 字幕生成：点击此按钮，右边是字幕生成的GUI
- 多人对话生成：点击此按钮，右边是最近的 session 列表
  - 角色管理：点击此按钮，右边是所有的角色列表
  - 项目管理：点击此按钮，左栏替换为项目二级菜单，需要加载项目

- 底部横 bar
 - 设置图标（使用 feather icon)：点击此图标
 - 夜间、日间、自动主题图标。
```
    - 二级项目菜单层级就像
```
<- 返回
- 项目1:点击项目，右边是具体此项目 session 列表（可名称排序、编辑时间排序、创建时间排序）
- 项目2：同上
```
    主界面点击 session，主界面再进入 session 界面，顶部面 pin 了返回键 + 项目名/session 名 的面包条。

# 技术栈
- 前端
  - react
  - tailwind
  - 你可能需要调研音频相关的UI库
- 后端
  - python 3.12，uv 管理依赖（pyproject.toml / uv.lock）。

