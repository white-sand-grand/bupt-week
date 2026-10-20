# 接口与深链参考

> 本文所有结论分三类标注：
> - **【实测】** — 从云邮前端线上 JS bundle 或 MYUCLOUD 可运行源码中直接读出，有据可查。
> - **【推断】** — 有间接证据，但未跑通。
> - **【待验证】** — 实现第一阶段必须首先验证的实验项。
>
> 逆向对象：`https://ucloud.bupt.edu.cn/uclass/`（`app.d43c9ed612d8b052819d.js`、`course.3b66a1e759c394024404.js`、chunk 21、chunk 49、`vendor.js`）。抓取时间 2026-10-16，bundle 哈希会随发版变化，届时需重新对照。

---

## 1. 云邮（ucloud）— 登录

### 1.1 主流程：CAS → ticket → OAuth 【实测】

来自 MYUCLOUD `server/services/ucloud.js`，是跑通过的实现。

固定配置：

```
CAS service : https://ucloud.bupt.edu.cn
API host    : https://apiucloud.bupt.edu.cn
OAuth 客户端: portal:portal_secret
Tenant-Id   : 000000
```

**第一步，取 CAS 登录页**

```http
GET https://auth.bupt.edu.cn/authserver/login?service=https%3A%2F%2Fucloud.bupt.edu.cn
```

保存响应 Cookie，从 HTML 提取三个隐藏字段：

| 字段 | 典型值 | 说明 |
|---|---|---|
| `type` | `username_password` | 基本不变 |
| `_eventId` | `submit` | 基本不变 |
| `execution` | — | **每次都变，必须实时取** |

**第二步，提交登录（关键：不跟随跳转）**

```http
POST https://auth.bupt.edu.cn/authserver/login?service=https%3A%2F%2Fucloud.bupt.edu.cn
Content-Type: application/x-www-form-urlencoded
Cookie: <第一步保存的 Cookie>

username=<学号>&password=<密码>&type=username_password&execution=<execution>&_eventId=submit&submit=LOGIN
```

必须 `redirect: 'manual'`，因为成功时返回 **302**，`Location` 形如：

```
https://ucloud.bupt.edu.cn?ticket=ST-xxxxxxxx
```

`ticket` 一次性，换完 token 不能复用。

> 浏览器做不到这一步：`redirect: 'manual'` 的响应是 opaque redirect，`Location` 头被浏览器吞掉。这是必须有服务端的根本原因。

**第三步，ticket 换 token**

```http
POST https://apiucloud.bupt.edu.cn/ykt-basics/oauth/token
Authorization: Basic cG9ydGFsOnBvcnRhbF9zZWNyZXQ=
Tenant-Id: 000000
Content-Type: application/x-www-form-urlencoded

ticket=<CAS ticket>&grant_type=third
```

成功响应：

```json
{
  "access_token": "<Blade-Auth token>",
  "token_type": "bearer",
  "refresh_token": "<refresh_token>",
  "expires_in": 7199,
  "scope": "all",
  "tenant_id": "000000",
  "user_name": "学号",
  "real_name": "姓名",
  "currentRole": "JS005",
  "account": "学号"
}
```

`access_token` 就是后续所有业务接口的 `Blade-Auth` 头。`expires_in: 7199` 秒 ≈ 2 小时，**必须配静默续期**，否则体验不可用。

### 1.2 备选流程：密码直接换 token 【待验证】

云邮 bundle 里存在 4 种 `grant_type`：`third`、`password`、`captcha`、`refresh_token`。其中 `password` 分支的调用链是：

```js
// app.js，登录页根据 URL 参数选择登录方式
var r = { ac: t.ac, pa: t.pa, grant_type: "password", scope: "all" };
this.loginCommpent(r)
// → AccountLogin2({ username: ac, password: pa, grant_type: "password", scope: "all" })
// → POST ykt-basics/oauth/token（密码原样，不哈希）
```

而默认分支走的是另一条：

```js
// course.js
AccountLogin: function (e) {
  return e.password && (e.password = d()(e.password)),   // d = 模块 NC6I
         post("ykt-basics/oauth/token", stringify(e))
}
// → AccountLogin({ username, password, grant_type, scope })
```

模块 `NC6I` 经确认是 **js-md5**（vendor bundle 内含 js-md5 0.7.3 源码）。也就是说这条路径发的是 **`md5(原密码)`**。

**如果 `grant_type=password` 能用，后端登录会从三步塌缩成一步**：一次 POST，无 Cookie 罐、无 redirect 处理、无隐藏字段解析。鲁棒性显著优于 CAS 流程。

但我不担保它现在还能用——可能是遗留接口或被限制了。**这是实现第一阶段的第一个实验**：

```sh
# 用 md5 后的密码试
curl -X POST https://apiucloud.bupt.edu.cn/ykt-basics/oauth/token \
  -H 'Authorization: Basic cG9ydGFsOnBvcnRhbF9zZWNyZXQ=' \
  -H 'Tenant-Id: 000000' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'username=<学号>' \
  --data-urlencode "password=$(printf '%s' '<密码>' | md5sum | cut -d' ' -f1)" \
  --data-urlencode 'grant_type=password' \
  --data-urlencode 'scope=all'
```

成功就走这条，CAS 流程作为 fallback 保留；失败就只用 CAS。**两条都实现，按可用性切换。**

### 1.3 刷新 token 【实测】

云邮前端的请求拦截器（`course.js`）：

```js
function m() {
  return g.post("/ykt-basics/oauth/token", qs.stringify({
    grant_type: "refresh_token",
    refresh_token: cookies.get("refresh_token")
  })).then(…)
}
// 401 时：换新 token → 写回 cookie → 重放队列里积压的请求
```

```http
POST https://apiucloud.bupt.edu.cn/ykt-basics/oauth/token
Authorization: Basic cG9ydGFsOnBvcnRhbF9zZWNyZXQ=
Tenant-Id: 000000
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token=<refresh_token>
```

后端照此实现：401 → 换 token → 更新会话 → 重试原请求一次。

---

## 2. 云邮 — 业务接口 【实测】

来源：MYUCLOUD `src/api/ucloud.js` 与 README「已确认业务接口」一节。

所有业务请求带三个头：

```
Blade-Auth: <access_token>
Authorization: Basic c3dvcmQ6c3dvcmRfc2VjcmV0     ← 注意与 OAuth 的 client 头不同
Tenant-Id: 000000
```

本项目中这些请求由后端代理，路径前缀 `/ucloud/` 映射到 `https://apiucloud.bupt.edu.cn`。

### 2.1 用户信息

```http
GET /ucloud/ykt-basics/info
```

登录后立刻调用，拿 `userId`（业务接口到处要用）和姓名。

### 2.2 课程列表

```http
GET /ucloud/ykt-site/site/list/student/current?userId=<userId>&siteRoleCode=2&current=1&size=9999
```

课程数组在 `data.records`，课程 ID 取 `id`。`size=9999` 一次拉全，避免分页。

### 2.3 作业列表

```http
POST /ucloud/ykt-site/work/student/list
Content-Type: application/json

{ "current": 1, "size": 100, "siteId": "可选，不传返回全部" }
```

作业数组在 `data.records`。不传 `siteId` 拿全部——本项目的「看作业」就是全量拉，前端自己按课程分组。

单条作业的关键字段（MYUCLOUD `src/utils/deadline.js` 的 `normalizeAssignment` 实测过这些名字）：

| 字段 | 含义 |
|---|---|
| `id` | 作业 ID，**做深链就用它** |
| `assignmentTitle` | 标题 |
| `assignmentBeginTime` / `assignmentEndTime` | 起止时间 |
| `siteId` / `siteName` | 所属课程 |
| `chapterName` | 章节 |
| `status` | 状态码（2 = 未提交，3 = 已提交，实测） |
| `submitTime` | 提交时间 |

### 2.4 作业详情

```http
GET /ucloud/ykt-site/work/detail?assignmentId=<assignmentId>
```

注意参数名是单数 `assignmentId`，写成 `assignmentld`（小写 L）会报缺少参数。

详情里的 `data.assignmentResource` 只有文件元数据摘要（`resourceId`、`resourceName`、`resourceType`），**没有下载链接**。要下载拿 `resourceId` 去调 `preview-url`，见 2.6。

### 2.5 作业提交状态

```http
GET /ucloud/ykt-site/work/submit-view?assignmentId=<assignmentId>
```

已提交作业返回上次提交内容、分数、批阅。用于在列表上标注「已提交 / 已逾期」。

实测响应样例：

```json
{
  "code": 200, "success": true,
  "data": {
    "assignmentId": "…", "assignmentContent": "",
    "assignmentComment": "", "score": -1,
    "status": 2, "isOvertimeCommit": 1, "assignmentStatus": 0
  }
}
```

### 2.6 附件下载地址 【实测】

```http
GET /ucloud/blade-source/resource/preview-url?resourceId=<resourceId>
Blade-Auth: <access_token>
Authorization: Basic c3dvcmQ6c3dvcmRfc2VjcmV0
Tenant-Id: 000000
```

远程路径：

```text
GET https://apiucloud.bupt.edu.cn/blade-source/resource/preview-url?resourceId=<resourceId>
```

成功响应：

```json
{
  "code": 200,
  "success": true,
  "data": {
    "previewUrl": "https://fileucloud.bupt.edu.cn/ucloud/document/<storageId>.<ext>?...",
    "onlinePreview": "https://ucloud.bupt.edu.cn/office/?ssl=1&n=1&bclr=000&furl="
  },
  "msg": "操作成功"
}
```

`previewUrl` 是**带签名的 fileucloud 直链**，带 `response-content-disposition=attachment` 参数。这就是下载用的地址，不需要再走 `resource/list/byId` 那两步。

> 参数名是单数 `resourceId`，和资源元数据接口的 `resourceIds` 不一样。

本项目把它包成：

```text
POST /api/ucloud/resource/download
Content-Type: application/json

{ "sessionId": "<后端会话 ID>", "resourceId": "<resourceId>" }
```

返回：

```json
{ "success": true, "data": { "fileUrl": "/file/ucloud/document/<storageId>.<ext>?..." } }
```

前端拿 `fileUrl` 直接 `fetch`，再走 blob + `<a download>` 落盘。

### 2.7 为什么下载必须经服务端 【实测】

`previewUrl` 指向 `fileucloud.bupt.edu.cn`，这个域名有两层限制，浏览器一条都绕不过：

1. **CORS 白名单**只放行 `Origin: https://ucloud.bupt.edu.cn`。本站（GitHub Pages 域名）直接 fetch 会被浏览器拦。
2. **防盗链**校验 `Origin` / `Referer`，同时**拒绝携带 `Authorization` / `Blade-Auth` 等业务鉴权头**——收到非 AWS4 签名直接报 `InvalidRequest`。

而附件本身又需要登录态才能从 `preview-url` 接口换出地址。所以链路只能是：

```
前端 → 后端（带 sessionId，换 previewUrl） → 改写成本站 /file 路径
      → /file 代理（设 Origin/Referer、剥掉鉴权头） → S3
```

### 2.8 /file 代理的行为 【实测】

`GET /file/*` → `https://fileucloud.bupt.edu.cn/*`：

| 处理 | 说明 |
|---|---|
| 目标 URL | 剥掉 `/file` 前缀，保留路径与查询（签名参数必须原样带） |
| `Origin` / `Referer` | 改写为 `https://ucloud.bupt.edu.cn/`（防盗链要求） |
| 剥掉的头 | `Authorization`、`Blade-Auth`、`Tenant-Id`、`Cookie`、`Host` |
| 透传的头 | `Range`（视频拖进度）、`If-Modified-Since` 等 |
| 上游 CORS 头 | 剥掉，改由本后端按 `CORS_ORIGINS` 发 |
| 重定向 | 跟随（浏览器直接跟会被防盗链拦） |
| 方法 | 只接受 GET |

超时 120s——课件可能几百 MB，30s 只够建连。

**防穿越**：`target.pathname` 是用 URL API 赋值而不是字符串拼 `href`，所以 `..` 会被规范化、`//evil.com` 也变不成 host。带 `..` 的路径在路由层就被折叠掉，根本进不了代理。测试里四种变形路径都断言了 origin 不变。

### 2.9 本期不实现的接口

`ykt-site/work/submit`（提交作业）、`blade-source/resource/upload/biz`（上传附件）。列在这里只是为了说明「已知但故意不做」，避免以后重复调研。

`preview-url` 里的 `onlinePreview` 字段用于 Office 在线预览（`https://ucloud.bupt.edu.cn/office/?...&furl=`），本期不做——预览是另一个功能，下载已经够用。要做的话走 `/office` 代理转发，注意它**必须保留路径前缀**，和 `/file` 的剥前缀不一样。

---

## 3. 深链：交作业跳转按钮 【实测】

这是本项目的核心功能。云邮前端是 hash 路由 SPA，入口 `https://ucloud.bupt.edu.cn/uclass/course.html`。

### 3.1 路由表（chunk 内实测）

```
/                                    → 重定向到 courseCenter
  └── /student                       （component A.a）
        ├── siteInfo_fullpage
        ├── notice / notice/noticeContent
        ├── studentAssignmentListPage          学生作业列表
        ├── assignmentDetails_fullpage         作业详情 / 提交页  ← 就是它
        ├── assignmentEvaluation_fullpage      作业互评
        └── …
```

### 3.2 作业详情页怎么拿参数 【实测，关键证据】

chunk 49 里，详情页组件的 `mounted`：

```js
mounted: function () { this.getAssignmentParams() },
getAssignmentParams: function () {
  var t = this, e = this.$route.query, s = e.activeTabName, a = e.assignmentId;
  this.isFromSubpage || (this.activeTabName = s),
  this.SET_ASSIGNMENTID(a),
  f.a.QueryAssignmentBasicInfogrxx(this.assignmentId).then(…)
}
```

**`assignmentId` 直接来自 `$route.query`，不依赖任何前置状态。** 所以最小可用深链是：

```
https://ucloud.bupt.edu.cn/uclass/course.html#/student/assignmentDetails_fullpage?activeTabName=first&assignmentId=<作业ID>
```

其余参数（`assignmentType`、`assignmentTitle`、`evaluationStatus`、`studentGroupId`、`isOpenEvaluation`）是 App 内导航时顺手带上的，详情页会从接口回填，**可以不带**。

> 建议实现时把已知的可选参数也带上，减少详情页的一次往返，但**不要依赖它们**——它们不是详情页的数据来源。

### 3.3 为什么作业列表页不能直接深链 【实测】

chunk 21，列表页的 `mounted`：

```js
mounted: function () {
  this.siteId = a.a.cookies.get("site-id"),      // ← 从 cookie 读，不是 query
  this.SET_SITEID(this.siteId),
  this.getStuAssignmentList(),
  …
}
```

`site-id` 这个 cookie 是用户在 App 里点进某门课程时写进去的。冷启动直接打开列表页，cookie 是空的或上一门课的，**列表会错或空**。

所以：**跳「具体作业」用详情页深链，不要跳列表页。**

### 3.4 带鉴权的深链 【实测，附带安全权衡】

chunk 21 / course.js 里多个页面的 `created` 钩子都有同一段：

```js
created: function () {
  this.$route.query.siteId && this.$route.query.roleId && this.$route.query.refresh_token
    ? this.setUserInfo()
    : (this.siteId = cookies.get("site-id"), …)
}
```

`setUserInfo()` 做的事（chunk 内实测）：

```js
setUserInfo: function () {
  var n = this.$route.query, a = n.siteId, s = n.refresh_token, r = n.roleId;
  cookies.set("refresh_token", s)
  return GetUserInfo().then(…)
    .then(...)
    .then(...)
    cookies.set("site-id", a)                      // ← 正好补上 3.3 的缺口
    localStorage.setLocalStorage("site", …)
}
```

也就是说这个 URL：

```
https://ucloud.bupt.edu.cn/uclass/course.html#/student/courseHomePage?siteId=<课程ID>&roleId=<roleId>&refresh_token=<refresh_token>
```

会把用户无感登录进云邮、并写好 `site-id` cookie，之后列表页也能正常用。

**权衡：`refresh_token` 会出现在 URL 里**，于是进浏览器历史、进 `Referer`、进任何第三方分析。`refresh_token` 是长效凭证，能反复换 `access_token`，比 `access_token` 更敏感。

**建议：默认不做这条。** 理由：

1. 3.2 的最小深链不需要登录态之外的任何东西，用户浏览器里通常已有云邮会话（本项目后端刚刚帮他们登过 CAS，或他们平时就登着）。
2. 把长效凭证塞进 URL 的收益，不值得换这个暴露面。
3. 真需要时再作为一个显式选项提供，并在 UI 上明确告知「此链接含登录凭证，勿外传」。

> 补充：如果用户浏览器没有云邮会话，打开 3.2 的深链会先落到 CAS 登录页，登一次即可。属于可接受的一次性成本。

---

## 4. 教务处（jwgl）— 登录与课表 【实测】

来源：MYUCLOUD `server/services/jwgl.js`、`server/parsers/timetable.js`。

### 4.1 登录：自定义编码 + Cookie 罐

教务处不用 CAS，用自己的编码。三步：

```js
// 1. 拿初始 Cookie
GET https://jwgl.bupt.edu.cn/jsxsd/

// 2. 提交（密码字段留空，真密码在 encoded 里）
POST https://jwgl.bupt.edu.cn/jsxsd/xk/LoginToXk
Content-Type: application/x-www-form-urlencoded
Origin: https://jwgl.bupt.edu.cn
Referer: https://jwgl.bupt.edu.cn/jsxsd/

userAccount=<学号>&userPassword=&encoded=<encoded>
```

`encoded` 的构造：

```js
encoded = encodeInp(username) + '%%%' + encodeInp(password)
```

`encodeInp` 是一个**自定义 base64 变体**（MYUCLOUD 注释写明是从 Python 版 `auto_evalued` 移植的）：字符集是标准 base64 的 `A-Za-z0-9+/=`，但每 3 字节一组的 padding 处理与标准 base64 不同。**直接抄 MYUCLOUD 的实现，不要自己重写**，抄错的表现是静默登录失败，很难查。

```js
function encodeInp(value) {
  const KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='
  let output = ''
  let i = 0
  while (i < value.length) {
    const chr1 = value.charCodeAt(i++)
    const chr2 = i < value.length ? value.charCodeAt(i++) : null
    const chr3 = i < value.length ? value.charCodeAt(i++) : null
    const enc1 = chr1 >> 2
    const enc2 = ((chr1 & 3) << 4) | ((chr2 ?? 0) >> 4)
    const enc3 = (((chr2 ?? 0) & 15) << 2) | ((chr3 ?? 0) >> 6)
    const enc4 = (chr3 ?? 0) & 63
    let enc3val, enc4val
    if (chr2 === null) { enc3val = 64; enc4val = 64 }
    else if (chr3 === null) { enc3val = enc3; enc4val = 64 }
    else { enc3val = enc3; enc4val = enc4 }
    output += KEY[enc1] + KEY[enc2] + KEY[enc3val] + KEY[enc4val]
  }
  return output
}
```

```js
// 3. 验证登录是否成功
GET https://jwgl.bupt.edu.cn/jsxsd/xspj/xspj_find.do
Referer: https://jwgl.bupt.edu.cn/jsxsd/
```

判据：响应体含 `/jsxsd/xk/LoginToXk`、`id="userAccount"` 或 `<title>登录</title>` → 登录失败。失败时把 HTML 转纯文本，检查是否含「用户名 / 密码 / 验证码 / 错误 / 失败」，拼进错误信息返回给用户。

三个请求的 `Set-Cookie` 要**按名字合并**（新的覆盖旧的），不能简单拼接。

### 4.2 课表

```http
GET https://jwgl.bupt.edu.cn/jsxsd/framework/xsdPerson.jsp?xkzc=<周次>&kbjcmsid=<节次模式>
Referer: https://jwgl.bupt.edu.cn/jsxsd/framework/xsMain_bjyddx.jsp
```

解析 `server/parsers/timetable.js`（直接从 MYUCLOUD 移植，63 行，无依赖）。它从 HTML 里抠出：

| 内容 | 来源 |
|---|---|
| 当前周次 | `var dqzc = '18'` |
| 节次模式 | `var kbjcmsid = '…'`（32 位十六进制） |
| 日期 | `id="xzrq"` 的 input value |
| 可选周次 | `<select id="xkzc">` 的 option |
| 节次模式列表 | `<select id="kbjcmsid">` 的 option |
| 星期表头 | `<ul class="table-header">` 下的 `<li>`，跳过第一个 |
| 节次与时间 | `<li class="row-one">` 下的 `<h5>` 和 `HH:MM~HH:MM` |
| 课程 | `<div class="table-class dayN">`，内含 `<h4>` 课名和 `<li>` 详情 |

课程块里的字段靠 `<li>` 文本前缀匹配：`上课时间`、`上课地点`、`上课校区`。上课时间形如 `[3-4]节`，据此算 `start` / `end`。

解析器对异常是** fail-loud **的：周次缺失、星期不是 7 天、节次对不上、时间格式不认识，都直接抛错而不是返回半份数据。这个行为要保留——宁可不显示，不要显示错的课表。

### 4.3 本期不实现

评教全链路（`/jsxsd/xspj/*` 的 find / list / edit / save / yjtj）。查课表只需要 `xsdPerson.jsp`。

---

## 5. 本项目自己的接口

设计原则：**薄**。后端只做「登录 + 取数 + 解析 + 代理」，不做业务判断。截止时间分级、排序、分组都在前端。

```
POST /api/ucloud/login          { username, password } → { sessionId, username, realName, expiresAt }
POST /api/ucloud/session        { sessionId }           → 校验并续期
POST /api/ucloud/logout         { sessionId }
GET  /api/ucloud/courses        ?sessionId=              → 课程列表
GET  /api/ucloud/assignments    ?sessionId=              → 全量作业（含 submit-view 合并）
GET  /api/ucloud/assignments/:id?sessionId=              → 单个作业详情

POST /api/jwgl/login            { username, password } → { sessionId, username, expiresAt }
POST /api/jwgl/session          { sessionId }
POST /api/jwgl/logout           { sessionId }
GET  /api/jwgl/timetable        ?sessionId=&week=        → 解析后的周课表

GET  /file/*                    → 代理 fileucloud.bupt.edu.cn（S3 防盗链处理）
```

`/file/*` 代理的三条规矩（MYUCLOUD `server/routes/proxy.js` 实测）：

1. 设 `Origin` / `Referer` 为 `https://ucloud.bupt.edu.cn/`
2. **删掉** `Authorization` / `Blade-Auth` / `Tenant-Id` —— 带了会被 S3 拒
3. `redirect: 'manual'`，并剥掉响应里的 `access-control-*` 头，改由本后端统一发 CORS 头

---

## 6. 登录失败的 stage 值

| stage | 卡在哪 | 常见原因 |
|---|---|---|
| `cas-get` | 取不到 CAS 登录页 | 网络 / auth.bupt.edu.cn 不可达 |
| `cas-login` | CAS 没返回 ticket | 账号密码错、验证码、风控、隐藏字段解析失败 |
| `oauth-token` | ticket 换 token 失败 | 客户端凭证变更、ticket 已用过 |
| `jwgl-login` | 教务处登录验证失败 | 账号密码错、验证码 |
| `jwgl-timetable` | 课表页解析失败 | 会话过期、页面结构变更 |

前端把 `msg` 展示给用户即可，`stage` 用于排查。

---

## 7. 待验证清单

实现第一阶段按顺序验证，每项都是独立可回退的：

| # | 验证项 | 方法 | 失败怎么办 |
|---|---|---|---|
| 1 | `grant_type=password` 是否可用 | 见 1.2 的 curl | 不可用就走 CAS，不影响其余 |
| 2 | `refresh_token` 能否反复续期 | 连续换 3 次 | 不能则缩短会话有效期，提示重登 |
| 3 | 深链在「无云邮会话」的浏览器里表现 | 无痕窗口打开 3.2 的 URL | 会跳 CAS 登录页，属预期 |
| 4 | `Headers.getSetCookie()` 在 Workers 可用 | 单元测试 | 不可用则退到 `get('set-cookie')` 解析 |
| 5 | `roleId` 的取值 | 登录后调 `UserRoleList` | 深链 3.4 才需要，不做就不影响 |
| 6 | 教务处 `encodeInp` 移植正确性 | 用真实账号登录一次 | 抄 MYUCLOUD 原版即可 |

第 1、2 项决定后端登录层的复杂度，**优先做**。
