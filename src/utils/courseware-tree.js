/**
 * 课件资料树的拉平（纯函数，零依赖）：目录节点与它挂的附件各成一行，
 * children 递归。字段名按防御式读取（上游存在别名）。
 */

/** 外链协议白名单：link 会原样进 <a href>，javascript:/data: 这类协议
 *  不该出现在受信界面（现代浏览器顶层导航会拦，但不该依赖这层）。 */
const SAFE_LINK = /^https?:\/\//i

/** 资料树的深度上限：上游塞超深树时递归会爆栈，错误文案还是英文黑话。 */
const MAX_TREE_DEPTH = 32

export function flattenTree(nodes, depth = 0, prefix = '') {
  if (!Array.isArray(nodes)) return []
  if (depth > MAX_TREE_DEPTH) return []
  return nodes.flatMap((node, index) => {
    if (!node || typeof node !== 'object') return []
    const nodeKey = `${prefix}${node.id || node.resourceId || index}`

    const fileRows = toArray(node.attachmentVOs ?? node.attachments).map((attachment, i) => {
      const resource = attachment?.resource || {}
      const rawLink = typeof attachment?.siteResourceLink?.link === 'string'
        ? attachment.siteResourceLink.link
        : ''
      const isLink = (String(attachment?.type) === '2' || Boolean(rawLink)) && SAFE_LINK.test(rawLink)
      return {
        key: `${nodeKey}-file-${resource.id || attachment?.id || i}`,
        depth: depth + 1,
        isLink,
        name: isLink
          ? attachment.siteResourceLink?.title || rawLink || '外部链接'
          : resource.name || resource.fileName || attachment?.name || '未命名附件',
        resourceId: resource.id || resource.resourceId || '',
        // fileSizeUnit 上游给的是「2.5MB」这类现成文案，ext 是不带点的后缀
        meta: isLink ? '外部链接' : [resource.ext, resource.fileSizeUnit].filter(Boolean).join(' · '),
        link: isLink ? rawLink : '',
      }
    }).filter((row) => row.isLink || row.resourceId !== '')
    // 下载不了的行不留：空 resourceId 点了必 400，还让多行共用 '' 进度键互相置灰

    return [
      {
        key: `node-${nodeKey}`,
        depth,
        isNode: true,
        name: node.resourceName || node.name || node.title || '未命名资料',
        meta: node.resourceTypeName || '',
      },
      ...fileRows,
      ...flattenTree(node.children, depth + 1, `${nodeKey}.`),
    ]
  })
}

function toArray(value) {
  return Array.isArray(value) ? value : []
}
