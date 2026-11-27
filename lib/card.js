/**
 * 把 DSH 的 Markdown 正文构造成飞书卡片 JSON 2.0。
 *
 * 参考同类飞书卡片实现，并针对自定义机器人 webhook 调整：
 * - 默认用 markdown 表格，避免老版本飞书客户端拒绝原生 table 元素；
 * - 长文按块分页，保证表格和代码块不会被切断；
 * - 可选在正文开头插入 `<at id=all></at>` 做卡片内 @all 强提醒，不额外发文本消息。
 */

/** 每张卡片正文的字符预算。 */
const CARD_CHAR_BUDGET = 6000
/**
 * 切换操作卡（模型/会话/权限模式切换及其回执）不追加模型小字。
 * 用 Symbol 标记，序列化到飞书时自动忽略。
 */
export const NO_MODEL_FOOTER = Symbol('noModelFooter')

/**
 * 给任意 Flybook 卡片 JSON 追加一行灰色模型小字；重复调用不会叠加。
 * 支持 Card 1.0 的 `elements` 与 Card 2.0 的 `body.elements`。
 */
export function withModelFooter(card, note) {
  if (!card || !note || card[NO_MODEL_FOOTER]) return card
  const clone = JSON.parse(JSON.stringify(card))
  if (clone[NO_MODEL_FOOTER]) return clone
  if (JSON.stringify(clone).includes('模型：')) return clone
  const elements = Array.isArray(clone.body?.elements) ? clone.body.elements : clone.elements
  if (!Array.isArray(elements)) return clone
  elements.push({ tag: 'markdown', content: `<font color='grey'>${note}</font>` })
  return clone
}

const TABLE_SEPARATOR = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/

function splitCells(line) {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  return text.split('|').map((cell) => cell.trim())
}

function isTableStart(lines, index) {
  const head = lines[index]
  const next = lines[index + 1]
  if (!head || !next) return false
  if (!head.trim().startsWith('|')) return false
  return TABLE_SEPARATOR.test(next.trim())
}

function readTable(lines, index) {
  const headers = splitCells(lines[index])
  const rows = []
  let cursor = index + 2
  while (cursor < lines.length && lines[cursor].trim().startsWith('|')) {
    const values = splitCells(lines[cursor])
    if (!values.every((value) => /^:?-{2,}:?$/.test(value))) rows.push(values)
    cursor += 1
  }
  return { headers, rows, next: cursor }
}

/** 把 Markdown 切成有序块：markdown / table / hr。 */
export function splitMarkdownBlocks(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let buffer = []
  let fenced = false

  const flush = () => {
    const content = buffer.join('\n').trim()
    if (content) blocks.push({ type: 'markdown', content })
    buffer = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      buffer.push(line)
      continue
    }
    if (!fenced && isTableStart(lines, index)) {
      flush()
      const table = readTable(lines, index)
      blocks.push({ type: 'table', headers: table.headers, rows: table.rows })
      index = table.next - 1
      continue
    }
    if (!fenced && /^\s{0,3}(-{3,}|\*{3,})\s*$/.test(line)) {
      flush()
      blocks.push({ type: 'hr' })
      continue
    }
    buffer.push(line)
  }
  flush()
  return blocks
}

const MAX_TABLE_COLUMNS = 6
const MAX_CELL_CHARS = 60

function clipCell(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (value.length <= MAX_CELL_CHARS) return value
  return `${value.slice(0, MAX_CELL_CHARS - 1)}…`
}

/** Card 2.0 原生表格元素（只有 tableMode=native 时才用）。 */
export function tableElement(table) {
  const headers = (table.headers.length > 0 ? table.headers : ['列 1']).slice(0, MAX_TABLE_COLUMNS)
  const columns = headers.map((header, index) => ({
    name: `c${index + 1}`,
    display_name: clipCell(header) || `列 ${index + 1}`,
    data_type: 'text',
  }))
  const rows = table.rows.map((row) => {
    const values = {}
    columns.forEach((column, index) => { values[column.name] = clipCell(row[index]) })
    return values
  })
  return {
    tag: 'table',
    page_size: 10,
    row_height: 'low',
    header_style: { text_align: 'left', text_size: 'normal', background_style: 'grey', bold: true, lines: 1 },
    columns,
    rows,
  }
}

function tableToMarkdown(table) {
  const headers = table.headers.length > 0 ? table.headers : ['列 1']
  const line = (values) => `| ${headers.map((_, index) => values[index] ?? '').join(' | ')} |`
  return [
    line(headers),
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...table.rows.map((row) => line(row)),
  ].join('\n')
}

function weigh(block) {
  if (block.type === 'hr') return 8
  if (block.type === 'markdown') return block.content.length + 40
  return tableToMarkdown(block).length + 40
}

/** 单行超过预算时按字符切，避免整段内容塞进一张永远超长的卡片。 */
function splitLongLine(line, budget) {
  const width = Math.max(1, budget - 40)
  if (line.length <= width) return [line]
  const pieces = []
  let rest = line
  while (rest.length > width) {
    pieces.push(rest.slice(0, width))
    rest = rest.slice(width)
  }
  if (rest) pieces.push(rest)
  return pieces
}

/** 单个 markdown 块超过预算时按行再切，避免长文永远塞进同一张卡片。 */
function chunkMarkdown(block, budget = CARD_CHAR_BUDGET) {
  if (block.type !== 'markdown' || weigh(block) <= budget) return [block]
  const chunks = []
  let current = []
  for (const rawLine of block.content.split('\n')) {
    for (const line of splitLongLine(rawLine, budget)) {
      const candidate = [...current, line].join('\n')
      if (current.length > 0 && candidate.length + 40 > budget) {
        chunks.push({ type: 'markdown', content: current.join('\n') })
        current = [line]
      } else {
        current.push(line)
      }
    }
  }
  if (current.length > 0) chunks.push({ type: 'markdown', content: current.join('\n') })
  return chunks
}

/**
 * 构造一张或多张卡片。
 * @returns {Array<object>} 可直接放进 webhook 请求 `card` 字段的卡片数组。
 */
export function buildContentCards({ title, template = 'blue', markdown, subtitle, note, tableMode = 'markdown', mentionAll = false, bodyLimit }) {
  const budget = Number.isFinite(bodyLimit) && bodyLimit > 0 ? Math.round(bodyLimit) : CARD_CHAR_BUDGET
  const body = mentionAll ? `<at id=all></at>\n${String(markdown ?? '')}` : String(markdown ?? '')
  const blocks = splitMarkdownBlocks(body)
  const parts = []
  let current = []
  let weight = 0

  for (const rawBlock of blocks) {
    for (const block of chunkMarkdown(rawBlock, budget)) {
      const blockWeight = weigh(block)
      if (current.length > 0 && weight + blockWeight > budget) {
        parts.push(current)
        current = []
        weight = 0
      }
      current.push(block)
      weight += blockWeight
    }
  }
  if (current.length > 0) parts.push(current)
  if (parts.length === 0) parts.push([{ type: 'markdown', content: '（这一轮没有文本输出）' }])

  // 超长正文不再截断：按用户配置的每张卡片字数全部发完。
  return parts.map((part, index) => {
    const elements = []
    for (const block of part) {
      if (block.type === 'hr') elements.push({ tag: 'hr' })
      else if (block.type === 'table') {
        elements.push(tableMode === 'native'
          ? tableElement(block)
          : { tag: 'markdown', content: tableToMarkdown(block) })
      } else {
        elements.push({ tag: 'markdown', content: block.content })
      }
    }
    if (note) elements.push({ tag: 'markdown', content: `<font color='grey'>${note}</font>` })

    const heading = parts.length > 1 ? `${title}（${index + 1}/${parts.length}）` : title
    return {
      schema: '2.0',
      config: { update_multi: true, width_mode: 'fill' },
      header: {
        title: { tag: 'plain_text', content: heading },
        ...(subtitle ? { subtitle: { tag: 'plain_text', content: subtitle } } : {}),
        template,
      },
      body: { elements },
    }
  })
}
