# MusicForUrl

MusicForUrl 是一个面向网易云音乐和 QQ 音乐的歌单/单曲视频生成服务。登录音乐账号后，粘贴歌单链接、单曲链接或歌单 ID，即可将曲目渲染并合并为支持拖动播放的整单 MP4；生成完成后可选通过 TMPLINK 上传，获得临时公开直链。

项目同时保留 M3U8、音频代理和单曲 MP4 等播放能力，适合个人媒体服务、网页播放器及 VRChat 等需要 URL 播放源的场景。

> 本项目只提供技术工具。请遵守音乐平台服务条款及所在地版权法律，仅处理你有权访问和使用的内容。TMPLINK 是独立的第三方服务，与本项目没有隶属关系。

## 功能概览

- 支持网易云音乐、QQ 音乐双平台。
- 支持歌单链接、歌单 ID 和单曲链接输入。
- 支持扫码登录；网易云额外支持短信验证码、密码和 Cookie 登录。
- 支持顺序播放和随机排序。
- 支持标准生成和极速生成，默认极速生成。
- 输出分辨率可选 `1600x900`、`1920x1080`，默认 `1920x1080`。
- 输出音质可选低、中、高，默认高音质。
- 标准模式可选 `5/10/15/30 FPS`，默认 `15 FPS`；极速模式固定 `1 FPS`。
- 单任务歌曲并发数可选 `2/4/6/8/16`，默认 `4`；首次选择 `8/16` 会显示稳定性提示。
- 多个歌单任务进入全局串行队列，前一个任务结束后才启动下一个任务。
- 浏览器刷新后仍可查看服务端任务进度，也可取消运行中或尚未启动的任务。
- 自动跳过已经确认不可播放的歌曲，并在结果中列出跳过项。
- 生成结果首先显示本地路径，再异步上传 TMPLINK 获取公开链接。
- 历史生成页面记录封面、歌单名、作者、生成时间、耗时、公开链接和本地路径。
- 历史公开链接会检测有效性、显示预计过期倒计时，并支持把仍存在的本地文件重新加入上传队列。
- 生成的视频支持 HTTP Range，可在兼容播放器中拖动进度。
- 音乐 Cookie 和 TMPLINK Token 加密后存入 SQLite；站点访问密码只保存加盐哈希。

## 生成效果和参数

### 标准模式

标准模式用于保留完整视觉效果：

- `5/10/15/30 FPS` 可选，默认 `15 FPS`。
- 歌词同步滚动，当前歌词的位移和字号变化都有动画过渡。
- 支持双语歌词；歌词内容出现“纯音乐，请欣赏”时整首按无歌词处理。
- 没有有效歌词时，不保留右侧歌词区域，标题、副标题和进度条自动居中。
- 歌曲画面保留封面、模糊背景和播放进度。
- 多曲歌单左下角显示歌单/专辑与作者，右下角持续显示当前曲目序号 `x / y`。
- 单曲不显示歌单/专辑归属信息。
- 曲目之间保留首尾画面过渡。

### 极速模式

极速模式优先降低视频帧渲染和编码开销：

- 固定 `1 FPS`，界面中选择的其他帧率不会生效。
- 不做渐入渐出。
- 不渲染歌词内容和歌词滚动动画。
- 过长的歌曲、专辑和歌手文字直接以 `...` 截断，不做滚动动画。
- 保留播放进度条、歌单/专辑归属信息和曲目序号。

极速模式通常能显著减少生成时间，但最终速度仍受歌曲下载速度、音频时长、分辨率、编码器和机器性能影响。

### 音质、分辨率和文件名

| 选项 | 请求音质 | MP4 音频码率 |
|---|---:|---:|
| 低 | 网易云约 128 kbps；QQ 使用 M500 | 96 kbps |
| 中 | 网易云约 192 kbps；QQ 使用 M800 | 128 kbps |
| 高（默认） | 网易云约 320 kbps；QQ 使用 M800 | 192 kbps |

实际源音质还取决于账号权限、歌曲是否提供对应档位及平台返回结果。输出文件名格式为：

```text
歌单名_高/中/低_极速/标准_AAAAxBBBB_XFPS.mp4
```

例如：

```text
我的歌单_高_极速_1920x1080_1FPS.mp4
我的歌单_中_标准_1600x900_15FPS.mp4
```

## 任务队列和数据保留

歌单级任务采用全局串行队列：同一时间只有一张歌单处于生成或上传阶段。一个歌单内部可以并发处理多首歌曲，因此“任务队列串行”和“歌曲生成并发”并不冲突。

- 新任务可以在其他任务生成期间继续提交，会按加入顺序等待。
- 当前任务和等待任务由服务端管理，刷新或关闭浏览器不会中断。
- 运行中任务可以取消；排队任务可以直接取消。
- 已完成、失败或取消的任务可在首页确认移除；成功记录仍保留在历史生成页面。
- 任务列表属于进程内状态，重启 Node.js 服务会清空运行中及排队任务；已写入 SQLite 的历史记录和已经生成的视频不会因此删除。
- 服务端内存中的终态任务会在一定时间后清理，历史记录以 SQLite 数据为准。

生成数据默认保存在：

```text
data/database.sqlite       # 用户、收藏、历史记录和加密凭证
data/playlist-mp4/         # 整单 MP4
data/hls/                  # HLS 分片
data/cache/                # 曲目与转码缓存
data/temp/                 # 临时文件
data/site-access.json      # 站点访问密码哈希
data/.encryption_key       # 仅开发环境自动生成的加密密钥
```

`data/`、`.env`、日志、SQLite 文件、临时分片及本地 TMPLINK 测试脚本均已被 Git 忽略。部署和迁移时请单独备份 `data/` 与 `ENCRYPTION_KEY`；密钥丢失或变化后，已有加密 Cookie 和 TMPLINK Token 将无法解密。

## 快速开始

### 环境要求

- Node.js `18`～`22`（推荐 Node.js 22 LTS）。
- npm。
- FFmpeg，且 `ffmpeg` 命令可从 `PATH` 访问。
- 建议安装可显示中文的字体；Docker 镜像已经安装 Noto CJK。
- SQLite 原生依赖的编译环境；常见 Node.js 版本通常可直接下载预编译包。

### Linux / macOS

```bash
git clone https://github.com/Jurangren/MusicForUrl.git
cd MusicForUrl
npm install
cp env.example .env
npm start
```

### Windows

可以直接双击或在 PowerShell 中执行：

```powershell
.\start-windows.bat
```

该脚本会通过 `npx` 使用项目已验证的 Node.js 22 LTS 运行时、安装或修复依赖、检查 FFmpeg，然后启动服务。也可以手动执行：

```powershell
npm install
Copy-Item env.example .env
npm start
```

打开 [http://localhost:3000](http://localhost:3000)。首次访问时，如果没有设置 `SITE_PASSWORD`，页面会引导创建至少 8 位的站点访问密码。

开发和检查命令：

```bash
npm run dev       # 监听后端文件变化
npm run check     # JavaScript 语法检查
npm test          # 完整自动化测试
```

启动时如果 `.env` 不存在，程序会根据 `env.example` 自动创建；以后模板新增的配置键也会自动补入现有 `.env`。请在生产环境启动前检查实际值。

## Docker 部署

### 基础部署

1. 打开 `deploy/docker-compose.yml`。
2. 将示例 `ENCRYPTION_KEY` 改为你自己的随机字符串，至少 16 位，建议 32 位以上。
3. 构建并启动：

```bash
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f
```

默认映射 `3000:3000`，并使用 named volume `music-for-url-data` 持久化 `/app/data`。如果希望直接保存到宿主机，可将 compose 中的 volume 改为：

```yaml
volumes:
  - ../data:/app/data
```

请确保挂载目录可由容器内的非 root 用户写入。

### 预设规格

需要让 compose 的资源限制生效时使用 `--compatibility`：

| 配置文件 | Node 堆内存 | HLS 并发槽 | FFmpeg 线程 | 缓存上限 | 资源限制 |
|---|---:|---:|---:|---:|---:|
| `docker-compose.1c1g.yml` | 256 MB | 1 | 1 | 1 GB | 1 CPU / 1 GB |
| `docker-compose.2c4g.yml` | 512 MB | 1 | 1 | 2 GB | 2 CPU / 4 GB |
| `docker-compose.4c4g.yml` | 1024 MB | 2 | 2 | 8 GB | 4 CPU / 4 GB |
| `docker-compose.8c8g.yml` | 2048 MB | 8 | 2 | 20 GB | 8 CPU / 8 GB |

示例：

```bash
docker compose -f deploy/docker-compose.4c4g.yml --compatibility up -d --build
```

前端允许选择的歌曲并发数不会绕过服务端 `HLS_MAX_CONCURRENT_JOBS` 上限。低配机器建议使用并发 `2` 或 `4`；`8/16` 可能造成 CPU、内存、磁盘或网络拥塞。

### 国内或受限网络构建

```bash
docker compose -f deploy/docker-compose.yml build \
  --build-arg ALPINE_REPO_MIRROR=mirrors.aliyun.com/alpine \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com
```

也可以通过同名环境变量为 compose 传入 `NODE_IMAGE`、`ALPINE_REPO_MIRROR` 和 `NPM_REGISTRY`。

### 更新与维护

```bash
# 拉取代码后重新构建
docker compose -f deploy/docker-compose.yml up -d --build

# 重启
docker compose -f deploy/docker-compose.yml restart

# 停止但保留数据卷
docker compose -f deploy/docker-compose.yml down

# 健康检查
curl http://127.0.0.1:3000/health
```

不要随意执行 `docker compose down -v`，它会删除 named volume 中的数据库、生成视频和缓存。

## TMPLINK 公开链接

生成视频始终先落盘。配置有效 TMPLINK Token 后，任务会在视频生成完成后继续上传并解析公开直链；没有配置或上传失败时，本地 MP4 仍然保留。

### 获取和保存 Token

1. 打开 [TMPLINK](https://www.ttttt.link) 并注册或登录。
2. 登录成功后按 `F12` 打开浏览器开发者工具。
3. 进入“应用（Application）”；如果标签被隐藏，可从顶部的 `»` 菜单进入。
4. 展开 `Local Storage`，选择 `https://www.ttttt.link`。
5. 找到键名 `app_token`，复制它的完整 Value。
6. 回到 MusicForUrl 的“个人中心 → 公开链接上传（TMPLINK）”，粘贴后点击“验证并保存”。

服务端会先向 TMPLINK 验证 Token，验证成功后才使用 `ENCRYPTION_KEY` 加密保存。Token 按音乐平台账号分别配置，不会明文返回给浏览器。

### 链接有效期和重新上传

- 当前生成链接按约 7 天估算有效期，实际状态和规则以 TMPLINK 为准。
- 历史页会异步访问公开链接：HTTP `200` 视为有效，`302` 视为无效或已过期。
- 预计过期时间以“x天x小时后”等相对格式显示。
- 点击“重新上传”会把本地视频加入全局任务队列，任务只执行上传，不重复生成视频。
- 如果本地文件已经被删除、移动或不在受信任的生成目录中，重新上传会被拒绝。

Token 相当于账号凭证，请勿截图、转发、写入 README、提交到 Git 或放入公开日志。怀疑泄露时应立即在 TMPLINK 退出登录或刷新凭证，并在个人中心移除旧 Token。

## 配置说明

完整模板见 `env.example`。下表中的默认值以当前代码为准，Docker 规格文件可能覆盖部分项目。

### 基础与安全

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `PORT` | `3000` | HTTP 服务端口。 |
| `NODE_ENV` | `development` | 设为 `production` 时必须配置 `ENCRYPTION_KEY`。 |
| `ENCRYPTION_KEY` | 开发环境自动生成 | Cookie 和 TMPLINK Token 的加密密钥；至少 16 位，建议 32 位以上。 |
| `SITE_PASSWORD` | 首次访问创建 | 可预设站点访问密码；未设置时由初始化页面创建。 |
| `TOKEN_TTL_HOURS` | `168` | 音乐账号登录 Token 有效期，单位小时。 |
| `PLAYBACK_TOKEN_TTL_SECONDS` | `172800` | 播放链接签名有效期，范围 30 秒～48 小时。 |
| `CACHE_TTL` | `86400` | 歌单元数据缓存时间，单位秒。 |
| `TRUST_PROXY` | `loopback` | 反向代理层数、IP 或子网；不要设置为宽泛的 `true`。 |
| `BASE_URL` | 请求地址 | 反向代理无法正确提供协议/Host 时指定外部访问地址。 |

### 生成与 FFmpeg

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `HLS_MAX_CONCURRENT_JOBS` | `16` | 单个歌单内允许占用的全局歌曲转码槽上限，最大 16。 |
| `HLS_MAX_QUEUE` | `20` | 底层转码等待队列上限。 |
| `HLS_DOWNLOAD_TIMEOUT` | `60000` | 单次音频/图片下载超时，单位毫秒。 |
| `HLS_DOWNLOAD_MAX_SIZE` | `104857600` | 单个下载允许的最大字节数。 |
| `HLS_FFMPEG_TIMEOUT` | `180000` | FFmpeg 无输出/无进度超时，单位毫秒。 |
| `HLS_FFMPEG_THREADS` | `0` | 单个 FFmpeg 进程线程数；`0` 表示自动。 |
| `HLS_SEGMENT_DURATION` | `10` | HLS 分片时长，单位秒。 |
| `HLS_AUTO_PRELOAD_COUNT` | `1` | 后台自动预生成的前 N 首歌曲；`0` 关闭。 |
| `PLAYLIST_GENERATION_CONCURRENCY` | `4` | 旧客户端未传并发参数时的回退值。 |
| `VIDEO_ENCODER` | `auto` | `auto/nvenc/qsv/amf/cpu`；自动实测硬件编码器，不可用时回退 `libx264`。 |
| `VIDEO_FONT_FILE` | 自动检测 | FFmpeg 使用的字体文件绝对路径。 |
| `VIDEO_TRANSITION_SECONDS` | `0.8` | 标准模式歌曲首尾整幅画面过渡秒数。 |
| `VIDEO_VISUAL_FPS` | `15` | 未由请求指定时的标准模式帧率回退值。 |
| `COVER_WIDTH` | `1920` | 未由请求指定时的画面宽度回退值。 |
| `COVER_HEIGHT` | `1080` | 未由请求指定时的画面高度回退值。 |
| `COVER_FPS` | `5` | 兼容旧封面视频接口的回退帧率。 |

旧的 `MUSIC_BITRATE` 已停用；整单生成的音质由每次任务的低/中/高选项决定。

### 缓存和日志

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `HLS_CACHE_MAX_SIZE` | 未设置 | 缓存字节上限，优先于 GB 配置。 |
| `HLS_CACHE_MAX_SIZE_GB` | `5` | 缓存容量上限，单位 GB。 |
| `HLS_CACHE_MAX_AGE_HOURS` | `24` | 缓存最长保留时间。 |
| `HLS_CACHE_CLEANUP_INTERVAL_MINUTES` | `60` | 自动清理周期。 |
| `HLS_CACHE_CLEANUP_TARGET_RATIO` | `0.8` | 超限后清理到容量上限的该比例以下。 |
| `LOG_HLS_VERBOSE` | `0` | 设为 `1` 或 `true` 输出详细转码日志。 |
| `HLS_DOWNLOAD_ALLOW_HOSTS` | 未设置 | 额外允许下载的主机正则，多个规则用逗号分隔。 |

### TMPLINK 与兼容接口

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `TMPLINK_SLICE_SIZE_MIB` | `80` | TMPLINK 上传分片大小，范围 1～80 MiB。 |
| `TMPLINK_API_BASE` | `https://connect.cntmp.link/api_v2` | TMPLINK API 地址，通常无需修改。 |
| `TMPLINK_WEB_BASE` | `https://www.ttttt.link` | TMPLINK 网页地址，通常无需修改。 |
| `LITE_VIDEO_BG_API_URL` | 内置图片接口 | 兼容轻量视频模式的随机背景图 API。 |
| `LITE_VIDEO_BG_API_TIMEOUT_MS` | `8000` | 随机背景图 API 超时，单位毫秒。 |
| `MP4_MAX_CONCURRENT_JOBS` | `4` | 旧单曲 MP4 接口并发上限。 |
| `MP4_MAX_QUEUE` | `20` | 旧单曲 MP4 接口等待队列上限。 |
| `MP4_DOWNLOAD_TIMEOUT` | `60000` | 旧单曲 MP4 下载超时。 |
| `MP4_DOWNLOAD_MAX_SIZE` | `104857600` | 旧单曲 MP4 最大下载字节数。 |
| `MP4_FFMPEG_TIMEOUT` | `180000` | 旧单曲 MP4 FFmpeg 超时。 |

## 反向代理

推荐在公网部署时使用 HTTPS。Nginx 示例：

```nginx
server {
    listen 443 ssl;
    server_name music.example.com;

    # ssl_certificate /path/to/fullchain.pem;
    # ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

对应环境变量：

```dotenv
TRUST_PROXY=1
BASE_URL=https://music.example.com
```

如果经过 Cloudflare + Nginx 两层代理，应根据实际拓扑设置 `TRUST_PROXY=2` 或精确的可信代理 IP/子网。

## 常见问题

### 生成任务一直为 0% 或立即失败

依次检查：

1. 音乐账号是否仍处于登录状态。
2. 歌单链接、歌曲链接或 ID 是否属于当前选中的平台。
3. `ffmpeg -version` 是否能正常运行。
4. `data/` 是否可写、磁盘是否有足够空间。
5. 是否修改或遗失了 `ENCRYPTION_KEY`。
6. 服务日志中第一条与该任务相关的错误。

Docker 使用：

```bash
docker compose -f deploy/docker-compose.yml logs --tail=300 -f
```

### 某些歌曲不可播放

程序会跳过已经明确确认不可播放的歌曲，例如歌曲下架、地区限制、账号权限不足或平台不返回可用地址。其他网络或转码错误仍会让任务失败，避免把服务异常误判为歌曲不可播放。

### 选择 8/16 并发反而更慢或不稳定

并发会同时增加下载、FFmpeg、CPU、内存和磁盘压力。并发值超过机器可用资源后会产生争抢，耗时可能增加。先使用默认值 `4`，再根据 CPU 占用、内存和磁盘吞吐逐步调整。

### 配置了硬件编码但仍使用 CPU

`VIDEO_ENCODER=auto` 会执行一次真实编码探测。驱动、FFmpeg 编译选项、设备映射或容器权限不满足时，会自动回退到 `libx264`。Docker 默认镜像不保证宿主机 GPU 能直接透传，需要自行提供驱动、设备和兼容的 FFmpeg 镜像。

### 视频生成成功但没有公开链接

本地生成和第三方上传是两个阶段。请检查个人中心是否保存了当前音乐账号对应的 TMPLINK Token、Token 是否过期、服务器能否访问 TMPLINK，以及本地文件是否仍存在。修复后可从历史生成页面点击“重新上传”。

### 页面刷新后任务还在，但服务重启后任务消失

这是当前设计：任务队列保存在 Node.js 进程内，所以浏览器刷新不影响；服务进程重启会清空活动队列。已完成视频和 SQLite 历史不受影响，可从历史页面查看或重新上传。

## 项目结构

```text
MusicForUrl/
├─ deploy/                  # Dockerfile 与不同机器规格的 compose 文件
├─ lib/                     # 平台接入、数据库、队列、歌词、上传和视频工具
├─ public/                  # SPA 页面、样式和浏览器脚本
├─ routes/                  # 登录、歌单、生成、播放、历史和上传接口
├─ tests/                   # Node.js 内置测试运行器测试
├─ env.example              # 环境变量模板
├─ server.js                # Express 入口
└─ start-windows.bat        # Windows 启动脚本
```

`/health` 是无需登录的健康检查接口。其他 `/api/*` 接口属于应用内部接口，可能随功能演进调整，不承诺第三方 API 稳定性。

## 安全建议

- 生产环境必须设置独立、随机且稳定的 `ENCRYPTION_KEY`。
- 使用 HTTPS，避免登录 Cookie、站点密码和 Token 在网络中明文传输。
- 不要把 `.env`、`data/`、数据库、日志或 TMPLINK Token 提交到 Git。
- 不要把 `TRUST_PROXY` 配置得比实际代理范围更宽。
- 定期备份数据库和生成文件，并限制 `data/` 的文件系统访问权限。
- 公开链接有时效但仍属于可访问资源，不要用于分发敏感或无授权内容。

## License

[MIT](LICENSE)

## 友情链接

[TMPLINK](https://www.ttttt.link)
