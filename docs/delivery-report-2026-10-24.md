# 全产品交付报告（2026-10-24）

按 [`delivery-plan.md`](delivery-plan.md) 的分块计划执行：A 安全隐私 → B 课表 →
C 作业 → D 验证交付。每块独立提交，全部经 WSL 互通命令完成，已推送 GitHub。

## 交付物清单

| 块 | commit | 内容 |
|---|---|---|
| 前置 | `1c26d90` | 安全审查修复（企微会话劫持 V1、开放代理 V2、无限速 V3、企微回流断点 B1、网络错误误清登录态 B2、SSO Cookie 复用落空 B2b、Windows 可移植性 P1–P3） |
| 计划 | `9fcc96b` | 交付大计划（分块、小任务、验收判据） |
| A | `7c1424b` | 安全隐私收尾：未知异常固定文案、kind 校验、全响应 Vary: Origin、隐私可证明测试、architecture.md 边界固化 |
| B | `f4da4a9` | 第 2 期课表：解析器移植、逐周缓存、周网格视图 |
| C | `4238f81` | 第 3 期作业：全量列表、紧急度分级、附件懒加载下载、交作业深链 |
| D | （本 commit） | 文档同步 + 本报告 + 推送 |

## 验证证据

| 项 | 结果 | 证据 |
|---|---|---|
| 接口/单元测试 | **181/181** | `npm test`（含新增 privacy 5、timetable 12、timetable-cache 5、assignments 6、deadline 6、rate-limit 3 等） |
| 浏览器测试 | **31/31** | `npm run test:browser`（Edge，`BROWSER_EXECUTABLE`）；新增：课表网格落位、切周零请求、作业排序分组徽标、附件懒加载与深链 href |
| 前端构建 | 通过 | `npm run build`（SFC 编译真门槛） |
| Workers 入口 | 通过 | `npx wrangler dev` 冒烟：health / timetable / assignments / detail 全部路由 shape 正确 |
| Node 入口 | 通过 | `npm run server`（Windows 上首次真正可用，经 `scripts/with-env-proxy.mjs`） |
| V1 攻击链复测 | 已断 | 恶意 Referer 种不进 cookie；无 state cookie 的 callback 返回 `error=wecom-state` 且不建会话（curl 双入口实测） |
| 限速实测 | 生效 | 真实 CAS 连错 10 次后第 11 次 429 |

## 学号与密码的隐私保障（可执行断言，非口头承诺）

`tests/privacy.test.js` 固化五条，任何一条回归都会挂测试：

1. 密码不进任何响应体（成功与失败路径都断言）；
2. 密码不进三种会话存储（File/KV/Memory 的落盘内容扫描）；
3. 密码不进服务端日志（统一脱敏为「长度+前后10字符」）；
4. 前端 localStorage 只有 sessionId/学号/姓名/过期时间四项（浏览器测试另有断言）；
5. 未知异常返回固定文案，内部细节只进日志。

配合既有机制：密码只在请求处理内存中存活、服务端会话只存派生凭证（token/Cookie）、
登录限速、企微 state 一次性绑定、前端地址只认白名单。全表见
`docs/architecture.md` §4「其他边界」。

## 实现说明与有意偏差

1. **作业提交状态语义**：按 MYUCLOUD 真实账号核对结论实现（`assignmentStatus`
   99/0/1 与 `submitTime`），而不是 api-reference §2.3 早期草稿的 `status`
   （它只表示作业进行/截止）。文档已加勘误注。
2. **不逐条合并 submit-view**（偏离 roadmap 第 3 期任务 1）：列表自带提交判定
   字段，逐条 detail 是 N 倍请求；submit-view 留给将来显示分数时再接。
3. **sessionId 走请求体**（偏离 api-reference §5 草稿的 query 形态）：沿用项目
   既定安全约定，§5 已重写为实际接口表。
4. **浏览器测试用 Edge 跑**：本机 chromium CDN 只有 ~62KB/s。测试框架支持
   `BROWSER_EXECUTABLE` 指定系统浏览器（本次交付新增的逃生通道），CI/其他
   环境仍用 chromium。
5. **子智能体**：按指示登记了 flash 模型子智能体定义（`.zcode/agents/flash.md`，
   新会话生效）；本会话启动早于该定义加载，参考源码调研由 general-purpose
   子智能体完成（产出：MYUCLOUD 课表解析器/deadline/缓存/jwgl 取数 +
   where_to_study 时区规范化，全部原样移植来源）。

## 遗留项（需要真实环境，不阻塞交付）

| # | 事项 | 需要什么 |
|---|---|---|
| 1 | 真实学号密码登录两个系统成功 | 用户凭证（错误凭证链路已实测通：401 + stage） |
| 2 | 教务处 CAS ticket 路径实测（`jwglVia: 'cas'` 而非回退 `legacy`） | 校园网（jwgl 从开发机不可达） |
| 3 | 真实课表拉取与解析 | 校园网 + 凭证（解析器 fail-loud，结构变更会明确报错） |
| 4 | 真实作业数据 + 深链人工点验（打开的是该作业提交页） | 凭证；点验方法见 roadmap 第 3 期 |
| 5 | 企业微信回流实测（微信内自动识别） | 微信客户端 |
| 6 | Cloudflare WAF 限速规则 | Cloudflare 控制台（建议配置见 deployment.md §6） |

## 复验命令

```sh
npm test                                   # 181 个全绿
BROWSER_EXECUTABLE="…/msedge.exe" npm run test:browser   # 31 个全绿（或先 npx playwright install chromium）
npm run build && npx wrangler dev          # 双入口冒烟
```
