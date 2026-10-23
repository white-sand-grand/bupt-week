# 全产品交付计划（2026-10-24）

端到端交付 BUPT-week：**查课表、看作业、交作业跳转链接**三大功能全部落地，
漏洞清零，学号密码的隐私保密措施完备，最终推送 GitHub。

本文件是大计划（分块 → 小任务 → 验收判据）。每个分块完成后独立提交一次
（按用户要求，提交统一走 WSL 互通命令），全部完成后出交付报告。

依据：`docs/roadmap.md`（分期判据）、`docs/api-reference.md`（接口实测状态）、
上一轮安全审查报告（已修复 V1/V2/V3、B1/B2/B2b、P1–P3，验证记录见交付报告）。

---

## 分块总览

| 块 | 内容 | 依赖 | 提交 |
|---|---|---|---|
| A | 安全与隐私收尾（消除漏洞的残余项） | 无 | commit ①②③ |
| B | 第 2 期：课表（后端解析 + 前端网格 + 按周缓存） | A | commit ④ |
| C | 第 3 期：作业（列表 + 截止分级 + 附件下载 + 深链） | A | commit ⑤ |
| D | 全产品 E2E 验证 + 文档 + 交付报告 + 推送 GitHub | B、C | commit ⑥ |

迭代顺序 A → B → C → D。每块内部先详细计划（见各节「小任务」）、再执行、
再按「验收判据」核对，判据不达成不提交。

---

## 块 A：安全与隐私收尾

**目标**：消除上一轮审查的全部残余项，学号与密码从输入到使用全程可证明地不留痕。

### 小任务

1. **A1 通用错误不外泄内部信息**：`server/app.js` 的 `onError` 对非 ApiError
   异常改返回固定文案「服务器内部错误」，原始 message 只进日志。
2. **A2 下载接口校验会话类型**：`/api/ucloud/resource/download` 增加
   `kind === 'ucloud'` 校验，教务会话来调返回 401「云邮登录已过期」。
3. **A3 响应统一 `Vary: Origin`**：命中与未命中白名单都带上，防共享缓存
   把无 CORS 头的响应错发给放行来源（`/file` 代理亦然）。
4. **A4 隐私可证明**：新增测试断言——登录请求的密码不出现在任何响应体、
   会话存储（File/KV/Memory 三种）的落盘内容、服务端日志输出里；
   前端 localStorage 仍只有 sessionId 等 4 项（已有浏览器测试，保持绿）。
5. **A5 隐私事实文档化**：`docs/architecture.md` 安全边界一节补齐本轮新增
   事实（限速、企微 state 绑定、Referer 白名单、错误兜底策略）。

### 验收判据

- [ ] 构造未知异常（如路由内 throw new Error('internal-xyz')）响应不含 internal-xyz
- [ ] 教务 sessionId 调下载接口得 401 + ucloud-auth
- [ ] 任意未命中 Origin 的 /api 与 /file 响应带 Vary: Origin
- [ ] A4 测试存在且全绿；`npm test`、`npm run build` 全绿
- [ ] 上轮已修复项（V1 攻击链、限速、state 绑定）回归测试仍全绿

---

## 块 B：第 2 期课表

**目标**：登录后能看到课表网格，按周缓存、断网不丢、切周不请求后端。

### 小任务

1. **B1 解析器**：`server/services/timetable.js` 从 MYUCLOUD
   `server/parsers/timetable.js` 移植（63 行、无依赖、fail-loud 语义保留：
   周次缺失/星期不足 7/节次对不上/时间格式不认识都抛错）。
2. **B2 取数**：同文件实现 `fetchTimetable({ cookies, week?, mode? })`：
   `GET /jsxsd/framework/xsdPerson.jsp?xkzc=<周>&kbjcmsid=<模式>`，
   Referer `…/xsMain_bjyddx.jsp`，会话失效复用 `validateJwglSession` 的登录页判据。
3. **B3 接口**：`POST /api/jwgl/timetable` body `{ sessionId, week?, mode? }`
   ——sessionId 走请求体是项目既定约定（query 会进访问日志），与
   api-reference §5 的草稿不同，以约定为准。返回解析后的周课表 + 可选周次列表。
4. **B4 前端 API**：`src/api/timetable.js`。
5. **B5 前端缓存**：`src/composables/timetable.js`——首次登录按周次列表逐周
   同步，每成功一周立刻写 localStorage（键含 username+mode 隔离）；切换周次
   只读缓存；断网时展示已同步周次并提示「尚有 N 周未同步」。
6. **B6 视图**：改造 `TimetableView.vue` 为真实周网格（星期 × 节次），周次
   切换、本周高亮、加载与错误态。
7. **B7 测试**：解析器用 HTML fixture（按 api-reference §4.2 的 DOM 结构
   构造）测正常/缺周次/坏时间格式；路由测 401/正常；浏览器测网格渲染与
   周次切换不发请求。

### 验收判据（对照 roadmap 第 2 期）

- [ ] mock 上游下能看到完整课表，课程名/地点/节次正确
- [ ] 切换周次不触发后端请求（浏览器断言）
- [ ] 解析器对残缺 HTML 抛错而非返回半份（fail-loud 测试）
- [ ] `npm test`、`npm run build`、双入口冒烟全绿

---

## 块 C：第 3 期作业

**目标**：作业列表 + 紧急度排序 + 附件下载 + 「去交作业」深链，核心功能闭环。

### 小任务

1. **C1 后端作业服务**：`server/services/assignments.js`
   - `listAssignments({ token })`：`POST ykt-site/work/student/list`
     `{current:1,size:100}`（不传 siteId 拿全量），透传 records。
   - `getAssignmentDetail({ token, assignmentId })`：`GET ykt-site/work/detail`
     （参数名单数 assignmentId），取 `data.assignmentResource` 附件元数据。
   - 响应校验沿用 `code===200/success!==false` 约定。
   - 说明：列表自带 status（2=未提交/3=已提交，实测），不逐条合并 submit-view；
     submit-view 留给后续显示分数时再接（偏离 roadmap 任务 1 的合并要求，
     理由与补偿记录进交付报告）。
2. **C2 接口**：`POST /api/ucloud/assignments`、`POST /api/ucloud/assignment/detail`
   （body 带 sessionId；kind 校验同 A2）。
3. **C3 深链工具**：`src/utils/assignment-url.js` 的 `buildAssignmentUrl(id)`
   ——参数集中一处（api-reference §3.2 最小深链；不带 refresh_token，§3.4
   的权衡结论是默认不做）。
4. **C4 截止时间分级**：`src/utils/deadline.js`——借鉴 MYUCLOUD 分级 +
   where_to_study 的时间规范化（无时区按 Asia/Shanghai 解释；「截止是时刻
   不是时长」）。排序：已逾期 → 今天/明天 → 一周内 → 待完成 → 已提交沉底。
5. **C5 视图**：改造 `AssignmentView.vue`——列表按课程分组 + 紧急度排序 +
   状态徽标；卡片展开时懒加载附件（C2 detail），附件按钮接既有
   `downloadResource()`；「去交作业」按钮用 C3 深链 `target=_blank`。
6. **C6 测试**：服务层 mock JSON；路由 401/kind 校验；deadline 分级单测
   （含时区边界）；浏览器测列表渲染、分组排序、深链 href 正确性。

### 验收判据（对照 roadmap 第 3 期）

- [ ] 列表完整：课程名、标题、截止时间、状态正确
- [ ] 排序符合分级规则（单测断言各档顺序）
- [ ] 「去交作业」href 是 §3.2 详情页深链（浏览器断言），非列表页
- [ ] 附件下载走既有链路且文件名为附件名（复用既有浏览器测试载体）
- [ ] `npm test`、`npm run build` 全绿

---

## 块 D：全产品验证与交付

### 小任务

1. **D1 全量回归**：`npm test`（目标全绿）＋ `npm run build` ＋
   `npx wrangler dev` 冒烟（health + timetable/assignments 路由 shape）。
2. **D2 浏览器 E2E**：`npm run test:browser`（BROWSER_EXECUTABLE=系统 Edge）
   含 B7/C6 新增用例。
3. **D3 文档同步**：README 进度表、roadmap 勾选、api-reference §5 与实际
   接口形状对齐（sessionId 走 body 的偏差注明）。
4. **D4 交付报告**：`docs/delivery-report-2026-10-24.md`——做了什么、验证
   证据、遗留项（真实凭证/校园网验证清单）。
5. **D5 推送 GitHub**：WSL 互通命令 `git push origin master`。

### 验收判据

- [ ] 全部测试与构建绿
- [ ] 交付报告存在且含每条判据的证据
- [ ] `git log` 显示各分块提交；`git push` 成功

---

## 全局约束（全程有效）

- 不加依赖；`server/` 除 `storage/file.js` 禁 `node:*`；错误形状
  `{success:false, msg, stage?}`；改动小、不顺手重构。
- api-reference 标「待验证」的结论不写成事实（本计划只用「实测」条目）。
- 每块提交统一走 WSL：`wsl.exe -e bash -lc 'cd /mnt/d/... && git add … && git commit …'`。
- 真实学号密码、校园网内 jwgl 的最终验收依赖用户环境，列入交付报告遗留项，
  不阻塞提交（代码路径全部有 mock 测试覆盖）。
