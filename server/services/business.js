import { ApiError } from '../http.js'
import { ClassRecords } from './class-records.js'
import { agentRequest, authenticateGrant, createGrant, listGrants, requireScope, revokeGrant } from './agent-grants.js'

export class BusinessService {
  constructor(store) { this.store = store }

  call(action, args = {}) {
    if (!this.store?.transaction) throw new ApiError(503, { code: 'TEMPORARILY_UNAVAILABLE', msg: '班级事务存储尚未配置' })
    return this.store.transaction(async (store) => {
      const classes = new ClassRecords(store, args.username)
      const input = args.input || {}
      if (action === 'create') return classes.create(input)
      if (action === 'join') return classes.join(input)
      if (action === 'changePassword') return classes.changePassword(args.classId, input)
      if (action === 'list') return classes.list()
      if (action === 'listAssignments') return classes.listAssignments(args.classId)
      if (action === 'addAssignment') return classes.addAssignment(args.classId, input)
      if (action === 'deleteAssignment') return classes.deleteAssignment(args.classId, input.assignmentId)
      if (action === 'dissolve') return classes.dissolve(args.classId)
      if (action === 'listSources') return classes.listSources(args.classId)
      if (action === 'addSource') return classes.addSource(args.classId, input.source)
      if (action === 'removeSource') return classes.removeSource(args.classId, input.sourceId)
      if (action === 'createGrant') return createGrant(store, args.username, input)
      if (action === 'listGrants') {
        const grants = await listGrants(store, args.username)
        return { grants: grants.map(({ hash, username, ...grant }) => grant) }
      }
      if (action === 'revokeGrant') return revokeGrant(store, args.username, input.id)
      if (action === 'agent') return agentRequest(store, args)
      if (action === 'sourceAccess') {
        if (args.key) {
          const grant = await authenticateGrant(store, args.key)
          requireScope(grant, 'addSource', args.classId)
          await new ClassRecords(store, grant.username).load(args.classId)
        } else await classes.load(args.classId)
        return {}
      }
      throw new ApiError(404, { msg: '接口不存在' })
    })
  }
}
