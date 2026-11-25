const ref = (name) => ({ $ref: `#/components/schemas/${name}` })
const string = (maxLength, minLength = 1) => ({ type: 'string', minLength, maxLength })
const response = (description) => ({ description, content: { 'application/json': { schema: ref('Envelope') } } })
const classId = { name: 'classId', in: 'path', required: true, schema: string(128) }
const idempotency = { name: 'Idempotency-Key', in: 'header', required: false,
  description: '正式写入必填；dryRun 为 true 时可省略。重试必须使用原值，同键不同内容返回 409。', schema: string(128) }

function operation(operationId, summary, schema, classPath = false) {
  return { operationId, summary, security: [{ AgentKey: [] }],
    parameters: [...(classPath ? [classId] : []), ...(schema ? [idempotency] : [])],
    ...(schema ? { requestBody: { required: true, content: { 'application/json': { schema: ref(schema) } } } } : {}),
    responses: Object.fromEntries([[200, '成功、预览或重放'], ...(schema ? [[201, '已创建']] : []),
      [400, '输入错误'], [401, 'Key 无效、过期或已撤销'], [403, '权限不足或班级密码错误'],
      [404, '对象不存在或超出范围'], [409, '重试内容冲突'], [413, '请求过大'], [429, '限流，见 Retry-After'], [502, 'GitHub 等资料源上游暂时不可用'], [503, '存储暂时不可用']]
      .map(([code, description]) => [code, response(description)])),
  }
}

const dryRun = { type: 'boolean', default: false, description: '仅校验和返回规范化内容，不写业务数据，也不消费幂等键' }
const object = (required, properties) => ({ type: 'object', additionalProperties: false, required, properties: { ...properties, dryRun } })

export const agentOpenApi = {
  openapi: '3.1.0',
  info: { title: 'BUPT-week Agent API', version: '1.0.0',
    description: '在网页「班级 → Agent 接入」生成独立 Key。仅操作本站班级、作业与班级资料源，不接收学校账号密码，不访问学校系统。调用地址使用本实例的后端 origin。' },
  paths: {
    '/api/agent/v1/me': { get: operation('getAuthorization', '查看当前授权') },
    '/api/agent/v1/classes': { get: operation('listClasses', '查询可访问的班级'), post: operation('createClass', '创建班级，需要账号范围及 classes:create', 'CreateClass') },
    '/api/agent/v1/classes/join': { post: operation('joinClass', '凭班级号及班级密码加入，需要账号范围及 classes:join', 'JoinClass') },
    '/api/agent/v1/classes/{classId}/assignments': {
      get: operation('listAssignments', '查询班级作业', null, true), post: operation('addAssignment', '录入作业', 'Assignment', true),
    },
    '/api/agent/v1/classes/{classId}/sources': {
      get: operation('listSources', '查询班级资料源', null, true), post: operation('addSource', '添加公开 GitHub 仓库或网页链接', 'Source', true),
    },
  },
  components: {
    securitySchemes: { AgentKey: { type: 'http', scheme: 'bearer', description: '独立 Agent Key；不要填写学校 token 或浏览器 sessionId' } },
    schemas: {
      CreateClass: object(['name', 'password'], { name: string(40), password: string(32, 4) }),
      JoinClass: object(['code', 'password'], { code: { type: 'string', pattern: '^(?:[2-9A-HJ-NP-Z]{8}|[2-9A-HJ-NP-Z]{10})$' }, password: string(32, 4) }),
      Assignment: object(['title', 'subject', 'content'], {
        title: string(100), subject: string(40), content: string(2000), externalId: string(128),
        deadline: { type: ['string', 'null'], description: '可省略；带显式时区、秒为 00 的合法日期，例如 2026-11-29T23:59:00+08:00' },
      }),
      Source: object(['type', 'url'], { type: { enum: ['github', 'link'] }, url: { type: 'string', format: 'uri', maxLength: 2048 }, name: string(100) }),
      Envelope: { type: 'object', required: ['success'], properties: { success: { type: 'boolean' }, data: { type: 'object' },
        msg: { type: 'string' }, code: { type: 'string' }, retryAfter: { type: 'integer' } } },
    },
  },
}
