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

## 第 2 期：课表 — ✅ 已完成（2026-10-24，mock 全链路；真实教务数据待校园网验证）

**目标**：能看课表，断网不丢数据。

### 任务

1. ✅ `services/timetable.js`：解析器从 MYUCLOUD 移植（fail-loud 保留）+ 取数
2. ✅ `POST /api/jwgl/timetable`（sessionId 走请求体，项目约定优先于本文早期草稿）
3. ✅ 首次登录后按周次列表全量同步，**每成功一周立刻写 localStorage**
4. ✅ `TimetableView.vue`（周网格、周次切换、本周高亮、未同步周次提示）
5. ✅ 缓存合并逻辑按 `username + mode + 学期` 隔离（`utils/timetable-cache.js`）

### 完成判据

- [x] 能看到本周课表，课程名/地点/节次正确（mock 上游 + 浏览器断言落位）
- [x] 能切换到任意已同步周次，**切换时不请求后端**（浏览器断言零请求）
- [x] 同步中途杀掉网络，已拿到的周次仍在，提示「尚有 N 周未同步」（partial 态）
- [x] 重新登录后重新同步，未覆盖的周次保留旧数据（mergeTimetableWeek 单测）
- [x] 课表页结构变更时**报错而不是显示半份错数据**（fail-loud 单测 ×3）
- [ ] 真实教务账号拉到真实课表 —— 需要校园网，见交付报告遗留项

### 注意

课表缓存按 `username + mode` 隔离。`mode`（`kbjcmsid`）是节次模式，不同模式下课表节次定义不同，混存会错位。（另加学期隔离：跨学期自动重建。）

---

## 第 3 期：作业与跳转链接 — ✅ 已完成（2026-10-24，mock 全链路；真实数据与人工点验待办）

**目标**：核心功能落地。

### 任务

1. ✅ `POST /api/ucloud/assignments`：全量作业列表。**不逐条合并 submit-view**——
   列表自带 `assignmentStatus`/`submitTime`（见 api-reference §2.3 勘误），
   足以判定提交状态；submit-view 留给将来显示分数时再接
2. ✅ `POST /api/ucloud/assignment/detail`：附件元数据（卡片展开懒加载）
3. ✅ `utils/deadline.js`：分级（借鉴 MYUCLOUD）+ where_to_study 时间规范化
   （无时区按 Asia/Shanghai；「截止是时刻不是时长」；往期未交不催促）
4. ✅ `AssignmentView.vue`：按课程分组 + 紧急度排序，已提交沉底
5. ✅ **跳转按钮**：`buildAssignmentUrl()` 拼 §3.2 最小深链（参数集中一处）
6. ✅ **附件下载**：接既有 `downloadResource()`，文件名为附件名

### 完成判据

- [x] 作业列表完整，课程名、标题、截止时间、状态正确（浏览器断言）
- [x] 排序：已逾期 → 今天/明天截止 → 一周内 → 待完成 → 已提交（单测断言全档顺序）
- [x] 「去交作业」的 href 是 §3.2 详情页深链（浏览器断言含 assignmentId、
      不含 refresh_token、不是列表页路由）
- [x] 已提交的作业正确标注，不计入未完成计数（浏览器断言）
- [x] 附件能下载到本地，文件名是附件名（既有浏览器下载用例保持绿）
- [ ] 无痕窗口（无云邮会话）点跳转，落到 CAS 登录页，登完后仍在正确的作业页
      —— 需要真实环境人工点验（roadmap 关键验收点，不删）
- [ ] 人工逐个作业点验跳转打开的是**那一门作业**的提交页 —— 同上

### 关键验收点

第 3 条和第 4 条是本项目存在的理由，**必须人工逐个作业点验**，不能只看代码。
代码侧已断言深链形状正确（含作业 ID、非列表页、不带凭证）；打开后的页面
内容核验依赖真实云邮会话，见交付报告遗留项。

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
