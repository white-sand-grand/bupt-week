# 真实凭证登录测试记录（2026-10-24，校外环境）

测试环境：本机 dev（前端 5173 / 后端 8787），测试者使用本人真实统一身份认证账号，浏览器为应用内浏览器（1280×720）。测试账号密码不计入本文档。

## 现象

三次登录尝试，全部失败，错误完全一致：

- 前端展示：`连不上教务系统，请检查网络`
- 接口：`POST /api/auth/login` → **502**，响应体 `{"success":false,"msg":"连不上教务系统，请检查网络","stage":"jwgl-connect"}`
- 耗时：4.0s / 1.7s / 1.1s（DNS 解析失败时失败得很快）

## 服务端日志要点（已脱敏）

云邮侧**三次全部成功**：CAS get 200 → CAS post 302 带 ticket → oauth/token 200 → 用户信息 200（返回真实姓名、学院、专业）。说明账号密码正确，云邮认证链路完整可用。

教务侧失败路径：`cas:get service=jwgl → 302`、`cas:sso → 302`（这两跳是访问 auth.bupt.edu.cn，公网可达），随后按 ticket 跳转 jwgl.bupt.edu.cn 时连接失败 → CAS 路径抛 `jwgl-connect` → 回退 legacy `loginJwgl` → 同样连不上 → 整体 502。

## 网络取证

| 测试 | 结果 |
| --- | --- |
| 公网 DNS（114.114.114.114）解析 jwgl.bupt.edu.cn | **NXDOMAIN（域名不存在）** |
| 公网 DNS 解析 ucloud.bupt.edu.cn | 211.68.69.240 正常 |
| 直连 curl https://jwgl.bupt.edu.cn | Could not resolve host |
| 经本机代理 127.0.0.1:7890 curl jwgl | TLS 握手失败（3.7s） |
| 经本机代理 curl ucloud | 200（0.5s） |
| 后端 Node 进程代理情况 | 未走任何代理：`NODE_USE_ENV_PROXY` 只读 HTTP(S)_PROXY 环境变量（shell 未设）；Windows 系统代理处于关闭状态，且 Node 本就不读系统代理 |

结论：**jwgl.bupt.edu.cn 的 DNS 记录只存在于校园网内**，公网任何出口（含普通代理/加速 VPN）都无法解析和访问。这不是用户网络故障，也开普通 VPN 无效；需要校园网或学校官方 VPN（EasyConnect / aTrust 这类会带来校内 DNS 的客户端）。

## 发现的问题清单

1. **【环境，非代码缺陷】** 校外环境教务系统不可达 → 统一登录整体失败，课表功能不可用。遗留验收项「校园网内 jwgl CAS 路径（jwglVia=cas）」仍未验证，需校园网环境。
2. **【产品决策点】** 登录是全有或全无：`loginBothSystems`（server/routes/auth.js:67）里云邮认证已完全成功，但教务失败直接抛 502，云邮 session 未持久化。校外场景下作业功能其实 100% 可用，用户却被完全挡在门外。可考虑降级登录：云邮成功即放行，教务侧标记不可用、课表页给出"仅校园网可用"提示。
3. **【文案误导】** 「连不上教务系统，请检查网络」会让校外学生去检查自己的网络/反复开 VPN（本次实测就发生了）。建议按失败类型区分文案：DNS 解析失败时明确说「教务系统仅限校园网访问（校外可用学校 VPN），作业功能不受影响」。
4. **【限流确认，无问题】** 登录限流只统计 401（密码错误），502 的 jwgl-connect 不占额度（server/rate-limit.js），校外反复重试不会触发 429 锁定。
5. **【环境噪音，非应用问题】** 页面 console 反复出现 `[RUM] ArmsEventBridge is not available, events dropped`，为宿主浏览器注入的遥测桥告警，仓库内无相关代码，与登录失败无关。

## 后续可选

- 等校园网环境做完整真实验收（jwglVia=cas 确认、真实课表/作业数据）。
- ~~实现「降级登录」（问题 2）+ 文案按失败类型细分（问题 3）~~ **已于同日修复**：降级登录（`jwgl: null` + `jwglMessage`，云邮会话照常建立）、CAS 消息中文映射（`Invalid credentials.` → 「学号或密码错误，请重新输入」）、jwgl-connect 文案带校园网场景说明，含服务端/浏览器测试与文档更新（见 git 历史 2026-10-24 提交）。

---

# 企微登录链路测试记录（2026-10-24，同日追加）

测试方式：curl 逐跳跟踪重定向链 + 应用内浏览器实测（非微信 UA）。真实微信客户端内的静默授权无法在本机模拟，见「限制」。

## 链路接线验证（全部通过）

| 跳 | 请求 | 结果 |
| --- | --- | --- |
| 1 | `GET /api/auth/wecom/start`（经 vite 代理） | 302 → `app.bupt.edu.cn/uc/api/oauth/index?...appid=200210806102757400&redirect=http://127.0.0.1:8787/api/auth/wecom/callback&state=TST-...`；`bupt-week-wecom-state` cookie 正常下发（HttpOnly/Secure/15min） |
| 2 | `GET app.bupt.../uc/api/oauth/index`（**微信 UA**） | 301 → `open.weixin.qq.com/connect/oauth2/authorize?appid=wxf1bb5361ed86c6ec&scope=snsapi_base`（微信官方 OAuth，企微公众号） |
| 2' | 同 URL（**普通浏览器 UA**） | 浏览器实测：被导向 `auth.bupt.edu.cn/authserver/login?noAutoRedirect=1&service=app.bupt...`（CAS 网页登录分支）——校方网关按 UA 分流 |
| 3 | 微信 OAuth 端点（无微信会话） | `connect_redirect=1` 自跳转一次后返回 GBK「抱歉，出错了」错误页——预期行为，snsapi_base 静默授权只能在真实微信客户端内完成 |
| 4 | `GET /api/auth/wecom/callback`（无 code/state，模拟取消） | 200 兜底页「企业微信登录已完成，但没能确定要跳回哪个页面…」，state cookie 正确清除 |

前端接收端确认存在：App.vue 解析 `#/login?wecom=ok&sessionId=…` → `adoptWecomSession`，含微信内自动发起（AUTO_WECOM_KEY）与 `wecom-*` 错误分支。

## 结论

- **「能不能接到企业微信」：能。** 接线从本站 start → BUPT 应用网关 → 微信官方 OAuth 全部按设计走通，企微身份识别完全由校方承担（我方代码不含任何 corp 配置，无可配错项），回流接收与安全校验（state 绑定）就绪。
- 完整闭环（微信内静默识别 → 拿 code → 换 ticket → 登录）**只能在真实微信客户端里验证**，本机模拟不了。

## 发现的问题（dev 环境限制，共 3 项）

1. **callback 地址按请求 Host 推导**（server/routes/auth.js:267 `backendOrigin`）：dev 经 vite 代理时 Host 是 `127.0.0.1:8787`，手机上收到这个回流地址必死。生产无此问题（公网域名）。
2. **state / frontend cookie 均带 `Secure`**：LAN IP 的 http 环境浏览器拒收 → 回流 state 校验必失败（`wecom-state` 错误）。生产 https 无此问题。
3. **dev 未配 `FRONTEND_URL`**：callback 成功后跳不回前端（有兜底提示页，不自动回站）。

→ 三项叠加的结论：**企微回流完整闭环只能在生产环境（https 域名 + FRONTEND_URL）验收**，与遗留清单「微信内企微回流」项一致；dev 下想验需专门改造（如允许 localhost 之外的 Secure 例外 + 显式配 FRONTEND_URL/回调地址覆盖），不值得为一次性测试引入。

---

# 错误密码路径测试记录（2026-10-24，同日追加）

测试方式：测试者手动输错密码 2 次（真实学号）+ 自动化复测 1 次（假学号 2099000001 + 假密码）。CAS 侧共 3 次 401，限流桶 3/10（窗口 10 分钟），远低于锁定阈值。

## 功能表现（正常）

- `POST /api/auth/login` → **401**，约 1.2s，响应 `{"success":false,"msg":"Invalid credentials.","stage":"cas-login"}`
- 流程正确地停在云邮 CAS 校验一步（stage=cas-login），密码错误时不会去碰教务系统
- 后端日志：`cas:get 200 (hasExecution) → cas:post 401 (no ticket)`，符合预期
- 错误提示带 `role="alert"`，样式清晰可读；输入框内容保留（密码不回显明文），便于改错重试
- 限流只计 401，正常用户不会被误锁

## 发现的问题

1. **【文案，建议修复】错误提示是英文「Invalid credentials.」**。来源：CAS 登录失败页的英文原文，被 `pickCasError`（server/services/cas.js:80）从 HTML 里提取后**原样透传**给了前端展示（cas.js:187 的 `pickCasError(errorHtml) || '统一认证没有返回票据，请检查学号和密码'`——提取命中就走英文原文，中文兜底永远轮不到）。全站中文界面里这一句很突兀，且"credentials"对学生不够直白。建议：在 401 分支对已知 CAS 消息做映射（如 `Invalid credentials.` → 「学号或密码错误，请重新输入」），未知的再兜底。

## 工具伪影备注（非应用问题）

IAB 的 Playwright locator `fill`/`click`/`press` 在此页面上无法触发 Vue 表单提交（疑似未派发框架依赖的 input/事件，表单被 required 拦截，后端零请求）；改用 CUA 真实键鼠事件路径（点击坐标 + 全选重打）后一次成功。今后在本机 IAB 里做表单类交互测试，优先用 CUA 路径。

---

# 深链白屏诊断与作业页改进（2026-10-24，同日追加）

用户实测「去交作业」跳转后白屏。逐层排查结论（完整证据链见 api-reference.md §3.2.1）：

1. 深链本身会先被云邮 SPA 弹到 CAS 登录页（文档假设成立），坏的是 **CAS 桌面皮肤**：其现代登录 UI 载体 `/authserver/cas/login-normal.html` 从浏览器发起**稳定 400**（Edge/Chromium/Electron 全复现；curl/Node fetch 同 URL 全 200，H1.1/H2 均排除，疑与浏览器特有请求头组合有关）。iframe 加载失败 → 整页只剩一个空 iframe → 白屏。
2. `dev=1`（CAS init.js 自留开关）跳过 iframe 直显老式内联表单，实测 3/3 稳定渲染。
3. 微信 UA 在加载皮肤前就被 CAS 自动转企微识别（mc-wx），**微信内不受影响**，坏的只是桌面浏览器路径。
4. 三个备选方案实测证伪：§3.4 query 鉴权（详情页路由照样被守卫弹走）、深链作 service + course.html?ticket（SPA 不消费 ticket）、courseHomePage 桥接（同样被弹）。根路径 `/?ticket=` 有网关层交换（实测发起 oauth/token）。
5. 落地：`去交作业` 改为经 `authserver/login?service=<完整深链>&dev=1` 入口。已登录云邮的浏览器被 CAS 自动直通到作业；未登录的登录后落在云邮首页，回本页再点一次即达。
6. 同批改进：作业卡片截止时间下新增细长进度条（4px，颜色复用紧急度色条，30s 时钟驱动）。起点数据实测 38/38 条 `assignmentBeginTime` 为空，故 `deadlineProgress` 在起点缺失时回退 7 天窗口（对齐「临近截止」分级阈值）。
