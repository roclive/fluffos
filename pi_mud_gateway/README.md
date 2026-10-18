# Pi MUD Gateway：离线回放与高层本地决策

## MUD-4：本地模型决策边界

新增 `lib/high_level_decider.mjs` 与 `lib/local_model_provider.mjs`。本地模型只在
`task_start`、`skill_complete`、`recovery_uncertain` 三种边界选择一个白名单
route/skill；固定 route 内的每一步继续由本地确定性执行器完成，不请求模型。
输出必须是且只能是 `id`、`params`、`reason`、`confidence` 四个 JSON 字段。
未知 id/参数、参数越界、非法 JSON 会拒绝且不执行；低于配置阈值时进入等待。

配置位于 `gateway.config.json` 的 `decision`。支持 Ollama 官方 `/api/chat` JSON
模式，或 GW 的 OpenAI-compatible `/v1/chat/completions` JSON object 模式。默认
`enabled: false` 且 `model` 留空：此时保留旧 gateway 模式，不创建高层 provider。启用新控制器时必须显式配置已有模型；高层 provider 不猜测模型名或自动转付费服务。旧模式沿用原 session 配置。若 GW 需要令牌，只填写环境变量名
`apiKeyEnv`，不要把密钥写入配置。免费剩余额度：`unknown`。

离线测试使用 fake provider/fetch，没有连接 Ollama、GW、MUD 或真实账号，也没有
消耗编码工具/云额度。覆盖边界调用次数、route 多步不调用模型、schema 与参数范围、
未知动作、低置信度等待，以及恶意 MUD 文本不能加入候选或注入命令。

本轮验收命令：

```sh
node --test pi_mud_gateway/tests/*.test.mjs
git diff --check
```

结果：35 tests / 35 pass，无 skip；`git diff --check` 通过。生产入口已从完整、可编译的 Git 祖先恢复，保留决策控制器和图寻路接入；新的构建回归检查入口及本地模块。真实模型和游戏账号冒烟未运行。详见文末 Manager recovery 记录。

产物绝对路径根目录：
`/Users/zhangdapeng/Desktop/ai-agent-manager/.aam/worktrees/MUD/MUD-4/pi_mud_gateway`。
关键产物为 `lib/high_level_decider.mjs`、`lib/local_model_provider.mjs`、
`tests/high_level_decider.test.mjs`、`gateway.config.json` 与本 README。

---

## MUD-1 基线记录

本目录生产入口是 `mud_gateway.ts`；`mud_gateway_verysilly.ts` 和 `gateway2_5 copy.ts` 是另存版本，启动脚本不使用它们，本轮未修改。仓库根 README 描述 FluffOS 的 CMake 构建，不是 Gateway 的 Node 测试流程。

## 验收与依赖

在工作树根目录执行；模块回放无需凭据或 MUD 服务。新增生产构建测试还需要相邻 `pi/node_modules` 中已安装的 esbuild：

```sh
node --test pi_mud_gateway/tests/*.test.mjs
```

`package.json` 的 placeholder test 已替换为上述真实套件的目录内等价命令：`npm --prefix pi_mud_gateway test`。验收记录使用直接 `node --test` 命令，不以 placeholder 或空测试代替。

本轮基线：Node v20.x，11 tests / 11 pass，无 skip。还执行了 `git diff --check`，以及以下纯转译语法检查（不执行 Gateway，不加载账号）：

```sh
pi/node_modules/.bin/esbuild pi_mud_gateway/mud_gateway.ts --format=esm --platform=node --outfile=pi_mud_gateway/tests/.gateway-syntax-check.mjs
node --check pi_mud_gateway/tests/.gateway-syntax-check.mjs
rm pi_mud_gateway/tests/.gateway-syntax-check.mjs
```

没有安装新依赖，没有执行启动／重启脚本，没有修改 checkpoint、游戏素材或服务。

## 启动与依赖映射

| 入口／资源 | 行为／依赖 |
| --- | --- |
| `run_gateway.sh` | 用 `nc` 检查本机 5555，切到 `../pi/packages/coding-agent`，通过 `npx tsx` 运行主入口；npx 本地缺包时可能联网，离线验收不使用此脚本 |
| `restart_gateway.sh` | **删除本目录 checkpoint.json** 后启动；不是测试命令 |
| `mud_gateway.ts` | Node net/fs/path；`ws` 提供监控 WebSocket；`@mariozechner/pi-coding-agent` 提供 session、resource loader、内存 session manager |
| `package.json` | 仅声明 ws / @types/ws；没有独立声明 tsx 或 coding-agent，生产仍依赖旁边 pi 工作区的安装／解析环境，尚非独立可发布包 |
| `gateway.config.json` | 配置加载后合并默认值；默认 MUD TCP 127.0.0.1:5555、UTF-8，默认 monitor 127.0.0.1:8099；实际运行以配置为准 |
| `skills/` | DefaultResourceLoader 的 additionalSkillPaths；系统 prompt 引导先查已知路线再执行 route skill |
| `checkpoint.json` / 运行时 memory 文件 | 轮次／状态恢复和长期记忆；路径由 config 与 ROOT_DIR 解析，离线回放不读写 |

主入口顶层调用 main，导入它会创建真实运行环境；测试只导入下列无启动副作用模块。

## 决策、skills、routes 边界

| 模块／位置 | 职责与保持的行为 |
| --- | --- |
| `lib/core.mjs` | 从原入口搬移的固定 KNOWN_ROUTES、方向别名、路线步骤读取、busy 等待、skill 轮转、文本清理与资源字段解析、stop 判定。无文件／网络／provider 依赖 |
| `parseStatusLine(text, player)` | 显式传入可更新的 player；原先隐式读写全局状态，现在由主入口传入原对象 |
| `detectStopReason(events, command, player)` | 显式注入当前资源；低气血阈值严格 `< 0.3`，查询命令豁免；中毒优先于战斗，再检查堵路／busy |
| `lib/transport.mjs` | sendMudCommand 保持末尾换行；collectMudEvents 注入 wait，等待后复制并清空队列。生产短序列和 route 均使用它，日志／trace 顺序保持 |
| `mud_gateway.ts` | 保留配置、socket 生命周期、房间／KB 解析、全局状态机、工具编排、route 偏离恢复、session、持久化和监控 |
| `skills/shaolin-water-carrying/SKILL.md` | 接活→取工具→出南门→河边灌水→随机山路分支→厨房交付；明确 gate 顺序和 busy 等待 |
| `skills/xkx2001-knowledge/` | map/NPC/master/skill/quest 静态数据，ontology 和 status-patterns；route.py 用图查询，不替代固定路线执行器 |

原行为有意保留：战斗提示通常继续；低气血如下一步是 hp 等信息命令可继续；固定路线中的模糊房名偏离规则仍在原入口，未在本轮调整。

## 回放设计与覆盖限制

`tests/fixtures/transcripts.json` 是依据已提交 `status-patterns.json` 和原停机文案构造的**合成离线文本**，不是声称来自真实账号的录制。它包含 ANSI、CRLF、状态资源和失败文案。固定挑水路线直接从生产 KNOWN_ROUTES 读取，避免测试另存路线漂移。

`tests/helpers/replay.mjs` 的 fake runner 用固定命令替代 agent/provider；MockTransport 严格核对每条命令与换行，意外命令立即失败，没有网络 fallback。虚拟 wait 注入响应并记录毫秒数，不实际等待，不消费编码工具或云调用额度。

覆盖：资源字段、文本过滤、低气血及查询例外、堵门／busy／中毒停机、战斗继续、人工接管、挑水五轮与每步等待、开门／敲门后立即穿门、skill 阻塞回退、方向别名、mock 负例、队列清空。

限制：测试真实共用模块和 transport 边界，但 fake runner 不等于完整生产工具处理器；未覆盖真实 TCP 分包／telnet 协商、房间消歧、完整 progressLoop、WebSocket UI、session compact、存档恢复或真实模型响应。未声称端到端测试通过。后续可沿显式 player、transport、wait 注入边界继续拆出工具执行器。

真实冒烟结果：**未运行**，遵循本任务不连接真实账号的约束。模型／provider 不在本轮新增、选择或调用范围；createSession 保留原默认解析路径，未枚举或宣称任何具体模型可用。免费剩余额度：`unknown`；未用估算花费推断额度。

## 产物位置

本轮仅修改 AAM 工作树，根路径：
`/Users/zhangdapeng/Desktop/ai-agent-manager/.aam/worktrees/MUD/MUD-1`

产物相对于该绝对根路径：`pi_mud_gateway/lib/core.mjs`、`pi_mud_gateway/lib/transport.mjs`、`pi_mud_gateway/tests/replay.test.mjs`、`pi_mud_gateway/tests/helpers/replay.mjs`、`pi_mud_gateway/tests/fixtures/transcripts.json`、本 README；集成修改在 `pi_mud_gateway/mud_gateway.ts` 和 `package.json`。开始时 `git status --short` 为空。未 add、commit、push 或推广到 base。


### Manager production recovery (MUD-4)

The production entry had inherited a literal truncation marker and lost over 3,000 lines from MUD-3. Restored the complete compilable ancestor's parser, WebSocket control, transport, tools, progress state machine, persistence and legacy session mode, retaining the high-level controller and graph pathfinder. A disabled decision provider keeps the existing gateway mode; enabling it requires the operator's explicit configured endpoint/model. No model was loaded or live game service started during verification.

High-level decisions consume one-shot input before calling the provider. WAIT and rejected decisions require a new operator revision, so persistent steering cannot cause a request loop; input arriving during a request is retained. Stopped/error/deviation and paused nested tool results stay WAIT and resume at recovery_uncertain, never skill_complete. Named fixed routes and graph destination room IDs share the execution path; unknown/mismatched current rooms stop movement before a command is sent.

`node --test pi_mud_gateway/tests/*.test.mjs` now includes production esbuild bundling (local imports checked, external packages excluded), graph route resolution and room guards, failed tool results and operator revision regressions. This compile check uses the installed sibling `pi/node_modules/esbuild`; it never imports/runs the gateway or invokes an AI CLI. It does not establish full TypeScript type safety, external-package availability, real game behavior or live model compatibility. Existing offline module tests remain intact.

### MUD-4 review regression

The production `loadConfig()` now delegates to `lib/gateway_config.mjs`, which merges all five supported sections, including `decision`. A file-backed regression test verifies that an enabled gateway provider retains its configured endpoint and model while inheriting omitted decision defaults. This prevents startup from receiving an undefined `config.decision` and ensures operator-selected local provider settings reach `main()`.

Verification commands: `node --test pi_mud_gateway/tests/*.test.mjs` (35/35 pass) and `git diff --check` (pass). Tests use temporary files and fake providers only. No live Ollama/GW/MUD smoke test was run, no service was started, and free quota remains `unknown`.

Review-fix artifacts are under `/Users/zhangdapeng/Desktop/ai-agent-manager/.aam/worktrees/MUD/MUD-4/pi_mud_gateway`: `lib/gateway_config.mjs`, `mud_gateway.ts`, `tests/production_build.test.mjs`, and this README.
