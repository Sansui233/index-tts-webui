# IndexTTS WebUI

基于 [IndexTTS 1.5](https://github.com/index-tts/index-tts) 的本地 WebUI。主要功能包括
- 单句语音生成
- 字幕生成
- 多角色对话 / 有声书的逐句生成、试听与合并

使用轻量但功能全面的架构。快速启动，任务队列，适合个人电脑使用。

![IndexTTS WebUI](assets/webui3.png)

模型许可见 `INDEX_MODEL_LICENSE`，使用须知见 `DISCLAIMER`。

## 环境准备

需要：

- NVIDIA 显卡与支持 CUDA 12.8 的驱动（可以自己改 pyproject.toml 中的依赖版本）
- [uv](https://docs.astral.sh/uv/)（ Python 3.12 与 PyTorch 2.8.0 + cu128）
- [Node.js](https://nodejs.org/) 与 [pnpm](https://pnpm.io/)（构建前端）
- `ffmpeg` 需在 PATH 中（字幕、合并音频使用）

在仓库根目录执行：

```powershell
uv sync
pnpm --dir frontend install --frozen-lockfile
pnpm --dir frontend build
```

下载 IndexTTS 1.5 模型到 `checkpoints/`：

```powershell
uv run huggingface-cli download IndexTeam/IndexTTS-1.5 config.yaml bigvgan_generator.pth bpe.model dvae.pth gpt.pth unigram_12000.vocab --local-dir checkpoints
```

（国内可先设置 `$env:HF_ENDPOINT="https://hf-mirror.com"`）

（可选）字幕生成还需要本地 Whisper 模型，可选 `tiny` / `base` / `small` / `medium`，放在 `checkpoints/whisper/whisper-<size>`：

```powershell
uv run huggingface-cli download openai/whisper-base --local-dir checkpoints/whisper/whisper-base
```

（可选）DeepSpeed 可选（`uv sync --extra deepspeed`），未安装时使用标准 PyTorch 推理。

## 启动

```powershell
uv run main.py          # 或双击 run.bat；可加 --host / --port
```

打开 http://127.0.0.1:7863 。模型在第一次生成时自动加载，也可在「设置」中手动加载 / 卸载以释放显存。

## 准备参考音频

参考音频放在仓库根目录的 `samples/`（也可以是指向其他目录的链接），在文件系统中自行整理；WebUI 会读取其中的音频作为参考音频。支持 wav、mp3、flac、ogg、m4a、aac。

```text
samples/
  角色1/
    0 正常.wav
    情绪/愉悦.wav
  角色2/
  _其他/
    晓晓.wav
```

- 给角色增删参考音频，就是在它的文件夹里增删文件；文件名会显示在选择框里，建议写上情绪或台词。
- 也可以在选择框旁上传音频，上传的文件保存在 `data/` 中；相同内容只保存一份。

## 使用

### 语音生成 / 字幕生成

- **语音生成**：选择参考音频（可输入文字筛选，↑↓ 选择、回车确认），输入文本，Ctrl + Enter 或点击生成。结果出现在「最近生成」和右下角任务面板中，可试听、重命名、下载。
- **字幕生成**：选择上传的音频、samples 中的音频或已生成的音频，选择 Whisper 模型与语言，生成后下载 SRT。

### 推理模式

推理参数中可选三种模式（单句生成、Session、预设都适用）：

| 模式 | 解码方式 | 适用 |
| --- | --- | --- |
| 普通推理（默认） | 原版解码，beam search（Beams 为束宽），任务排队逐个执行 | 单句精修 |
| 批次推理 | 原版解码，长文本分句后按长度分桶批量生成 | 单个长文本 |
| 并发推理 | 逐步调度（continuous batching）：多句同时解码，短句先完成，不等长句；任务不排队，可与其他任务同时运行。Beams 表示 best-of-N（每句采样 N 次，取平均概率最高的一条） | 台本批量生成、API |

同一份台本（8 句）实测：普通推理 25.9 秒，并发推理 9.6 秒。两种解码对同一句的结果不同；批量生成后个别不满意的句子，可切回普通推理单独重新生成。

### 角色与预设

- **角色管理**：新建与 `samples/` 下文件夹同名的角色，文件夹中的音频即其参考音频（专用角色）。旁白、路人等没有固定声音的角色勾选「匿名角色」，可使用任意音频。角色改名前，请先在文件系统中把文件夹改成新名字。
- **预设管理**：把一组「说话人 → 角色 + 参考音频」和推理参数保存为预设。新建 Session 时可选择预设；Session 设置中也可「存为预设」（同名覆盖）。

### 项目与 Session（多人对话 / 有声书）

1. 新建 Session（一个章节或一段对话），可选预设：在「多人对话生成」中新建时可以不属于任何项目；有声书可在「项目管理」中建项目，再在项目中新建。Session 的所属项目可在设置中随时更改。
2. 点击「台本」，按每行一句写入文本：

   ```text
   [旁白] 故事从这里开始。
   [卡维] 你威胁我？卑鄙！
   （括号开头的行和空行是注释）
   ```

   右侧会逐行对比现有句子：绿色为新增，黄色为修改，红色为删除，格式错误的行会列出，修正后才能确认。之后可以随时再用「台本」批量增删改，未改动的句子保留已生成的音频。
3. 在「设置」中为每个说话人绑定角色与参考音频，调整推理参数与句间隔。
4. 「全部生成」或逐句生成。每次生成都会保留为一个 Take，可展开试听历史 Take 并选择当前使用的版本；文本或参数改动后，旧 Take 会标记为「已过期」。
5. 「合并」按当前顺序把每句的当前 Take 拼成一个音频，可在页面底部试听、下载、生成字幕。

其他操作：

- 句子悬停可上下移动；右上角「多选」可勾选多句后批量下载（zip）、清理或删除。
- 「清理」删除不再需要的音频：可选「未使用的 Take 与已删除句子的音频」或「仅已删除句子的音频」。当前 Take 不会被删除。
- 生成、合并、字幕都在右下角的任务面板中排队执行（并发推理的生成任务不排队，直接开始），可取消、查看详情、复制错误信息、清除记录。

### API（供其他程序调用）

在「API」中新建接口，每个接口有自己的地址 `/tts/<路径>`、默认推理参数和访问方式：

- **公开**：`GET /tts/<路径>?voice=<音色>&text=<文本>`，或 POST JSON，无需认证。
- **私有**：仅 `POST`，需带 `Authorization: Bearer <token>`；token 自动生成，可随时重新生成。

POST 的参数可以是 JSON，也可以是表单字段或 URL 参数（`text`、`voice`），方便听书软件调用。

```powershell
curl -X POST http://127.0.0.1:7863/tts/live -H "Authorization: Bearer <token>" -H "Content-Type: application/json" `
  -d '{"text": "你好", "voice": "kaveh", "generation": {"temperature": 0.9}}' -o out.wav
```

`voice` 可以是接口中保存的音色名（「生成链接」会为常用参考音频保存一个名字并给出可复制的链接 / curl 命令），也可以直接用**任意参考音频**：参考音频 id 或 samples 内的相对路径（如 `卡维/0 正常.wav`）。调用方可用 `GET /tts/<路径>/voices` 查询所有可用的 voice 值（已保存的音色、samples 路径、上传音频的 id；私有 API 需带 token），API 页右上角「调用说明」中的「可用参考音频」列表也可直接复制。请求在生成完成后返回 WAV（API 总是使用并发推理，不排在界面任务后面，多个调用一起解码；接口参数中的模式不生效，Beams 表示 best-of-N；最多等待 10 分钟），调用记录出现在任务面板与 API 页的「最近调用」中，并打印在服务器控制台。生成的音频写入临时文件，发送给调用方后立即删除，不会保存。

#### 听书配置（阅读 / 爱阅记 / 服务端阅读）

每个 API 卡片的「听书配置」把**已保存的音色**生成为听书软件的在线朗读引擎（格式参考 [tts-importer](https://github.com/yy4382/tts-importer)）：

| 软件 | 格式 | 导入方式 |
|---|---|---|
| 阅读（legado） | httpTTS JSON，每个音色一个引擎 | 手机上点「一键导入」（`legado://`）；或 朗读引擎 → ⋮ → 网络导入 粘贴链接；或本地导入下载的 JSON；单个音色可「粘贴源」 |
| 服务端阅读（hectorqin/reader） | 同阅读 | 朗读设置的 HttpTTS 中网络导入链接或导入 JSON；reader 服务器需能访问本机地址 |
| 爱阅记 | JxdAdvCustomTTS，所有音色合为一个语音库 | 在线语音库管理 → ⋮ → JSON 输入 中粘贴 |

先在弹窗中填写「服务器地址」：听书软件访问本机的地址（如 `http://192.168.1.5:7863`），不能是 127.0.0.1。网络导入链接为 `/tts/<路径>/profile/legado`（私有 API 附带 `?token=`），配置中的地址取自软件实际访问的主机。私有 API 的配置包含 token，请勿公开。

默认只监听 127.0.0.1；供局域网调用需 `uv run main.py --host 0.0.0.0`。注意此时 WebUI 本身（`/api`）也对局域网开放且没有认证，token 只保护 `/tts` 接口。

## 数据与备份

WebUI 的所有数据（角色、预设、项目、Session、API、生成的音频、任务记录）保存在 `data/`，可用环境变量 `WEBUI3_DATA` 指向其他目录。备份时复制 `data/` 与 `samples/` 即可。

## 文档

- [docs/architecture.md](docs/architecture.md)：前后端结构、模块与数据一致性规则
- [docs/data.md](docs/data.md)：`data/` 目录与记录格式

开发：后端运行时执行 `pnpm --dir frontend dev`（http://127.0.0.1:5173）；测试 `uv run python -m unittest discover -s tests`。
