# 实施计划

分四期，每期有明确的**完成判据**。判据不达成不进入下一期。

技术栈已定：Vue 3 + Vite（Pages）+ Hono（Workers / Node）。不再讨论选型。

---

## 第 0 期：脚手架与登录实验（最小可验证）— ✅ 已完成

**目标**：把最不确定的两个技术风险先排掉，再动手写业务。

### 已完成

1. ✅ `server/` 骨架：`app.js` 工厂、`http.js`、`cors.js`、三种会话存储、两个 entry
2. ✅ `src/` 骨架：Vite + 后端健康状态页 + `api/client.js`
3. ✅ `vite.config.js` 配 `/api`、`/file` 开发代理
4. ✅ 边界不变量测试（含「真的会失败」的反向验证）
5. ⬜ **实验 A**：`grant_type=password` 是否可用 — **待做**
6. ⬜ **实验 B**：`refresh_token` 能否连续续期 3 次 — **待做**

### 实测结果

- `npm test` 102 个测试全绿
- `npm run server` 与 `npx wrangler dev` **同一份 `server/` 代码**，无环境分支
- `vite build` 通过，产物用相对路径（Pages 子路径部署可用）
- `/file` 代理实测打到 `fileucloud.bupt.edu.cn`，S3 返回 `NoSuchKey`；上游 CORS 头已剥除、本后端 CORS 头已补上
- 附件下载链路（`preview-url` → `/file` 路径 → 代理）后端部分已建，接口在无会话时正确返回 401 + `stage`

### 过程中发现并修掉的两个真 bug

都不是测试先行发现的，是实测才暴露的，记在这里免得重复踩：

1. **`fetch()` 返回的 `Response`，其 `headers` 是 immutable 的。** 想就地 `delete('access-control-*')` 会抛 `TypeError: immutable`，必须复制成新的 `Headers` 再重建 `Response`。顺带：重建时要丢掉 `content-length` / `content-encoding`——undici 已按 `content-encoding` 解压过 body，保留原 `content-length` 会让浏览器按压缩尺寸截断。
2. **Hono 里 handler 返回原始 `Response` 时，中间件用 `c.header()` 设的头会被丢掉。** 所以 `/file` 代理必须自己算 CORS 头。已把规则抽成 `corsHeadersFor()` 纯函数，中间件与代理共用，避免两处漂移。

### 完成判据（逐条核对）

- [x] `npm run dev` 能打开页面，`/api/health` 返回 200
- [x] `npm run server` 与 `npx wrangler dev` 都能起来，且**同一份 `server/` 代码**
- [x] `server/` 下除 `storage/file.js` 外无 `node:*` import（写个测试断言这条）
- [x] 该测试**真的会失败**：直接违规与传递违规两种场景各验证过一次，之后已还原
- [ ] 实验 A、B 有明确结论并记录在 `docs/api-reference.md`

### 下一步

先做实验 A、B（curl 见 `docs/implementation-plan.md` 末尾），结论写回 `docs/api-reference.md`，再动第 1 期。

---

## 第 1 期：两个系统的登录 — ✅ 已完成（真实凭证待用户验证）

**目标**：前端能登进去，凭证安全落在服务端。

### 已完成

1. `services/ucloud.js`：CAS 三步登录（实验 A 成功则加密码直连作为首选，CAS 作 fallback）
2. `services/jwgl.js`：`encodeInp` + 三步 Cookie 罐登录（从 MYUCLOUD 原样移植）
3. `POST /api/ucloud/login`、`/api/jwgl/login`、`session`、`logout`
4. 前端 `LoginPanel.vue` + `src/composables/auth.js`（导出 `jwglAuth` / `ucloudAuth` 两个实例）
5. 错误信息带上 `stage`，前端直接展示 `msg`

### 实测结果

- 102 个接口测试 + 14 个浏览器测试全绿
- **CAS 流程打过真实上游**：`cas:get` 200、`cas:post` 401，返回
  `Invalid credentials.` + `stage: cas-login`——链路是通的，只差有效凭证
- Node 与 Workers 两条入口行为完全一致（含错误码与 stage）
- 服务端日志确认脱敏：全文无密码、无 ticket、无 execution 值

### 完成判据

- [x] 登错时的错误信息能让人看懂（不是 `fetch failed`）——网络错误按
      `ECONNREFUSED`/`ETIMEDOUT`/`ENOTFOUND` 等翻成中文，并提示代理问题
- [x] 刷新页面后登录态保持（浏览器测试）
- [x] **前端 localStorage 里只有不透明 sessionId，没有密码、没有 token**（写测试断言）
- [x] 服务端日志里密码和 token 都以 redact 形式出现（只留长度和前后 10 字符）
- [ ] 用真实学号密码，两个系统都能登录成功 —— **需要你的凭证**
- [ ] 教务处 `encodeInp` 用真实账号验证过（抄错会静默失败）—— 需要校园网

### 注意

`encodeInp` 看着像自定义变体，**实测就是手写的标准 base64**（65 字符 key 只是让下标 64 映射到 `=`）。照抄 MYUCLOUD，不要重写。真正的验收只能靠真实账号登录一次，没有捷径。

---

## 第 2 期：课表

**目标**：能看课表，断网不丢数据。

### 任务

1. `parsers/timetable.js`：从 MYUCLOUD 移植（63 行，无依赖）
2. `GET /api/jwgl/timetable?week=N`
3. 首次登录后按周次列表全量同步，**每成功一周立刻写 localStorage**
4. `TimetableGrid.vue` + `TimetablePage.vue`（周次切换、本周高亮、未同步周次提示）
5. `utils/deadline.js` 暂不需要，但 `utils/timetable.js` 的缓存合并逻辑现在就要

### 完成判据

- [ ] 能看到本周课表，课程名/地点/节次正确
- [ ] 能切换到任意已同步周次，**切换时不请求后端**
- [ ] 同步中途杀掉网络，已拿到的周次仍在，提示「尚有 N 周未同步」
- [ ] 重新登录后重新同步，未覆盖的周次保留旧数据
- [ ] 课表页结构变更时**报错而不是显示半份错数据**（保留解析器的 fail-loud）

### 注意

课表缓存按 `username + mode` 隔离。`mode`（`kbjcmsid`）是节次模式，不同模式下课表节次定义不同，混存会错位。

---

## 第 3 期：作业与跳转链接

**目标**：核心功能落地。

### 任务

1. `GET /api/ucloud/assignments`：拉全量作业，后端合并 `submit-view` 标注已提交状态
2. `GET /api/ucloud/assignments/:id`
3. `utils/deadline.js`：截止时间分级（借鉴 MYUCLOUD）+ where_to_study 的时间规范化
4. `AssignmentList.vue` + `AssignmentCard.vue`：按紧急度排序，已提交的沉到底
5. **跳转按钮**：拼 3.2 的最小深链
6. **附件下载**：接口已就绪（见下），把 `src/api/files.js` 接到作业卡片的附件列表上

### 附件下载的当前状态

后端和前端模块都已建好并测过，缺的只是「有附件列表可挂」：

| 部件 | 文件 | 状态 |
|---|---|---|
| `/file` 代理 | `server/routes/proxy.js` | ✅ 已建，含 Range / 防穿越 / 流式测试 |
| 下载地址解析 | `server/services/resources.js` | ✅ 已建，`preview-url` → `/file` 路径 |
| 下载接口 | `server/routes/api.js` | ✅ 已建，`POST /api/ucloud/resource/download` |
| 前端下载 | `src/api/files.js` | ✅ 已建，`downloadResource(resourceId, filename)` |
| 挂到作业卡片 | `AssignmentCard.vue` | ⬜ 等本期作业列表落地 |

第 3 期要做的事只剩最后一行：在作业详情/卡片的附件列表上渲染下载按钮，调 `downloadResource()`。

### 浏览器验证（已就位）

`tests/browser/browser.test.js`，跑 `npm run test:browser`。验的是接口测试做不到的事：

| 验什么 | 怎么验 |
|---|---|
| Vue 应用真的挂载 | 读 `h1` 文本 + 等 `.status-ok` 出现 |
| 下载落盘 + 文件名 | Playwright 捕获 `download` 事件，断言 `suggestedFilename()` 是附件名，并读回落盘内容 |
| 下载失败可读 | 走 `/api` 代理打后端 404，断言错误文案 |
| CORS 放行 | 从已放行来源的页面里 `fetch` 后端 |
| CORS 拦截 | 从未放行来源的页面里 `fetch`，断言被浏览器拦 |
| 401 形状 | 无会话调下载接口，断言 `success/stage/msg` |

两个关键断言都做过**反证**：把 `anchor.download` 删掉，文件名测试失败；把 CORS 头全去掉，
放行测试失败。还原后 14/14 通过，文件字节一致。

载体页 `tests/browser/fixtures/download-harness.html` import 的是 `src/api/files.js` 里
真实的 `downloadFile`，不是复制品。

### 完成判据

- [ ] 作业列表完整，课程名、标题、截止时间、状态正确
- [ ] 排序：已逾期 → 今天/明天截止 → 一周内 → 待完成 → 已提交
- [ ] **点「去交作业」打开的是该作业的提交页**，课程、标题、截止时间都对得上
- [ ] 无痕窗口（无云邮会话）点跳转，落到 CAS 登录页，登完后仍在正确的作业页
- [ ] 已提交的作业正确标注，不再计入紧急度
- [ ] 作业附件能下载到本地，文件名是作业里显示的附件名（不是 S3 的 storageId.ext）
      ——浏览器侧已用 Playwright 验过（见下），接上作业列表后只需复跑 `npm run test:browser`

### 关键验收点

第 3 条和第 4 条是本项目存在的理由，**必须人工逐个作业点验**，不能只看代码。

特别确认：跳转打开的不是作业**列表**页。3.3 已说明列表页依赖 `site-id` cookie，冷启动会空。如果发现跳到了列表页，说明深链拼错了。

---

## 第 4 期：部署与打磨

**目标**：能在 Pages 上日常使用。

### 任务

1. `wrangler.toml` 配 KV，`CORS_ORIGINS` 填真实地址
2. GitHub Actions 跑通，`VITE_BACKEND_URL` 仓库变量配好
3. `npx wrangler dev` 全流程验证后再 deploy
4. 移动端适配（课表网格横向滚动，作业列表单列）
5. README 补实际上线后的地址和截图

### 完成判据

- [ ] 推送 master 后 Actions 自动发布，Pages 地址可访问
- [ ] 无痕窗口全流程：登录 → 课表 → 作业 → 跳转
- [ ] 手机上能看课表（可横向滚动）和作业列表
- [ ] `docs/deployment.md` 第 7 节检查清单全勾

---

## 明确不做

列出来是为了防止范围蔓延：

| 不做 | 理由 |
|---|---|
| 站内提交作业 | 需求是「提供跳转链接」。站内提交要处理文件上传、S3 防盗链、FormData，工作量约 3 倍且偏离需求 |
| 评教 | MYUCLOUD 已有完整实现，直接用它 |
| 空教室查询 | where_to_study 已有 |
| 成绩查询 | 未在需求内 |
| 课程资源 / 视频 / Office 预览 | 未在需求内（作业**附件**下载已做，见第 3 期） |
| 多用户 | 个人工具，单用户假设 |
| 后端数据库 | 会话存储 KV 足够，不引入 DB |
| 状态管理库 | 三个 ref 够用 |

---

## 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| `grant_type=password` 不可用 | 登录层只能用 CAS 三步 | 第 0 期先验证；CAS 流程 MYUCLOUD 已跑通，有 fallback |
| `workers.dev` 校园网不可达 | 前端连不上后端 | 绑自定义域名，或退 VPS（`npm run server`，代码不改） |
| 云邮改版，深链失效 | 核心功能失效 | 深链参数集中在 `buildAssignmentUrl()` 一处，改路由只改这里；bundle 哈希记在 `api-reference.md`，可重新对照 |
| 教务处页面结构变更 | 课表解析失败 | 解析器 fail-loud，会明确报错而非显示错数据 |
| `Headers.getSetCookie()` 在 Workers 不可用 | Cookie 合并退化 | 保留 `get('set-cookie')` 解析作为 fallback |
| `refresh_token` 续期失败 | 每 2 小时重登 | 第 0 期实验 B 验证；失败则缩短 TTL 并提示 |

---

## 从两个参考库借什么

| 借鉴项 | 来自 | 怎么用 |
|---|---|---|
| CAS 三步登录 + ticket 换取 | MYUCLOUD `server/services/ucloud.js` | 直接移植 |
| `encodeInp` + Cookie 罐登录 | MYUCLOUD `server/services/jwgl.js` | 直接移植，不重写 |
| 课表 HTML 解析器 | MYUCLOUD `server/parsers/timetable.js` | 直接移植（63 行） |
| 截止时间分级与排序 | MYUCLOUD `src/utils/deadline.js` | 移植，去掉提交相关分支 |
| 课表按周增量缓存 | MYUCLOUD `src/utils/timetable.js` | 移植 |
| 附件下载链路 | MYUCLOUD `src/api/ucloud.js` + `AssignmentDetailPanel.vue` | `preview-url` 拿直链 → 改写 `/file` → 代理 → blob + `<a download>` |
| 会话存储注入 | MYUCLOUD `createBackend({ getSessionStore })` | 继承这个设计，补 KV 实现 |
| 「截止时间是时刻不是时长」 | where_to_study `src/course-domain.js` | 时间规范化：无时区的时间戳按 Asia/Shanghai 解释 |
| 已读作业去重的基线语义 | where_to_study `src/assignment-seen.js` | 第 3 期之后如加「新作业」提示再用，本期不引入 |
| 修订号守卫的异步存储 | where_to_study `src/course-data-owner.js` | 并发请求丢弃过期响应，第 2/3 期用得上 |
