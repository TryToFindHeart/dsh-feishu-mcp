/**
 * 飞书消息链接兼容。
 *
 * 飞书「复制消息链接」生成的是 applink token，不是 message_id。公开 OpenAPI
 * 目前没有把 token 反查成消息/附件的接口，因此这里只做能可靠完成的部分：
 * 从正文里认出链接、去重、把原文和说明一起交给 DSH。模型至少知道用户指向了
 * 哪几条消息；若链接里是文件或图片，仍需要用户转发原消息或直接发送附件。
 */

const APPLINK_PATTERN = /https?:\/\/applink\.(?:feishu\.cn|larksuite\.com)\/client\/message\/link\/open\?token=[^\s<>"']+/gi

/** 从任意文本里抽出飞书消息链接，保留 URL 编码，去掉常见尾随标点。 */
export function extractFeishuLinks(text) {
  const links = []
  const source = String(text || '')
  for (const match of source.matchAll(APPLINK_PATTERN)) {
    const url = match[0].replace(/[，。；、！？）)\]】》]+$/u, '')
    if (url && !links.includes(url)) links.push(url)
  }
  return links
}

/** 把链接清单和无法解析的说明追加到正文末尾。 */
export function annotateFeishuLinks(body, links) {
  if (!Array.isArray(links) || links.length === 0) return body
  const list = links.map((url, index) => `${index + 1}. ${url}`).join('\n')
  const note = links.length === 1
    ? '用户粘贴了 1 条飞书消息链接。当前飞书 OpenAPI 无法把链接 token 解析成消息内容，这里只提供链接原文；若需要处理链接里的文件或图片，请让用户转发原消息或直接发送文件/图片。'
    : `用户粘贴了 ${links.length} 条飞书消息链接。当前飞书 OpenAPI 无法把链接 token 解析成消息内容，这里只提供链接原文；若需要处理链接里的文件或图片，请让用户转发原消息或直接发送文件/图片。`
  return `${body || ''}\n\n【飞书消息链接】${note}\n${list}`.trim()
}
