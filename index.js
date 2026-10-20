// dsh-reme-obsidian — 宿主端插件：把 ReMe 知识库（digest）导入 Obsidian 库
//
// 设计（已与用户确认）：
//   · 只导入 ReMe 工作区的 digest 目录（AI 整理后的知识笔记）
//   · 触发方式：注册 reme_import_to_obsidian 工具，由 agent 在对话中调用（不做启动自动/定时）
//   · 落点：vault 下单一文件夹 ReMe/，文件名用笔记的中文标题（frontmatter 的 name）
//   · frontmatter 合并：保留 ReMe 原有字段，追加 source / category / imported_at
//   · digest 里指向未导入笔记的 wikilink 改写成纯文本，避免在 Obsidian 里产生破链
//   · 直读工作区文件（不走 ReMe HTTP API），故 ReMe 服务不在线也能导入
//
// 纯宿主端、无 UI、无构建步骤（ESM JS 直接加载）。

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'reme-obsidian'
export const inject = ['tools', 'connection']
export const removable = true

const DEFAULT_CONFIG = {
  /** ReMe 工作区的 digest 目录 */
  remeDigestDir: 'D:\\AI\\deepseek harness\\reme-workspace\\digest',
  /** Obsidian 库根目录 */
  vaultDir: 'D:\\repository\\my',
  /** 库内的目标文件夹名 */
  targetFolder: 'ReMe',
  /** 总索引笔记的文件名 */
  indexName: '知识库索引.md',
  /** 是否把无法解析的 wikilink 改写成纯文本 */
  rewriteDanglingLinks: true,
}

/** 浏览器半调用宿主端导入逻辑的 RPC 路径（client.js 用 rpc.call('/api', 'reme-obsidian/import', ...)） */
const RPC_PATH = '/api/reme-obsidian/import'

// ---------------------------------------------------------------------------
// 内联 defineTool / domainTable 等 helper
// 对齐 dsh-emotion 的 src/vendor.ts：npm 上的 dsh 包滞后，宿主端插件不宜直接依赖。
// ---------------------------------------------------------------------------

export function defineTool(options) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(options.parameters || {})) {
    properties[key] = { type: spec.type, description: spec.description || '' }
    if (spec.required) required.push(key)
  }
  const parameters = { type: 'object', properties, ...(required.length ? { required } : {}) }
  const output = options.output || {}
  const schema = output.schema || {}
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema,
      render: (args, value) =>
        output.render ? output.render(args, value) : [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const missing = required.filter((k) => args?.[k] === undefined)
      if (missing.length) throw new Error(`missing required argument(s): ${missing.join(', ')}`)
      return options.execute(args || {}, exec)
    },
  }
}

// ---------------------------------------------------------------------------
// 文本处理
// ---------------------------------------------------------------------------

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const FM_LINE_RE = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/

/** 拆出 YAML frontmatter（返回原始行，避免引入 YAML 依赖做往返序列化） */
function splitFrontmatter(text) {
  const m = text.match(FM_RE)
  if (!m) return { fmLines: [], body: text }
  return { fmLines: m[1].split(/\r?\n/), body: text.slice(m[0].length) }
}

/** 取 frontmatter 中某个键的值（只认第一个，去掉包裹引号） */
function readFmValue(fmLines, key) {
  for (const line of fmLines) {
    const m = line.match(FM_LINE_RE)
    if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, '').trim()
  }
  return ''
}

/** YAML 单引号标量：反斜杠不转义，只需把单引号翻倍 */
function quoteYaml(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

function firstHeading(body) {
  const m = body.match(/^#[ \t]+(.+?)[ \t]*$/m)
  return m ? m[1].trim() : ''
}

/** 文件名净化：去掉 Windows/Obsidian 非法字符 */
function sanitizeFileName(input) {
  const cleaned = String(input)
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim()
  return cleaned.slice(0, 80).trim() || 'untitled'
}

function walkMarkdown(dir) {
  const found = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name)
    if (ent.isDirectory()) found.push(...walkMarkdown(abs))
    else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) found.push(abs)
  }
  return found
}

/**
 * 改写 wikilink：
 *   · 目标是已导入的笔记 → [[中文标题]] 或 [[中文标题|标签]]
 *   · 否则 → 纯文本（有标签用标签，无标签用目标文件名）
 */
function rewriteLinks(body, resolveTitle) {
  return body.replace(/\[\[([^[\]]+?)\]\]/g, (full, inner) => {
    const sep = inner.indexOf('|')
    const targetRaw = (sep === -1 ? inner : inner.slice(0, sep)).trim()
    const label = (sep === -1 ? '' : inner.slice(sep + 1)).trim()
    if (!targetRaw) return full
    const base = targetRaw.split('/').pop().replace(/\.md$/i, '').trim()
    const hit = resolveTitle(targetRaw, base)
    if (hit) return label && label !== hit ? `[[${hit}|${label}]]` : `[[${hit}]]`
    return label || base
  })
}

const norm = (p) => path.resolve(p).toLowerCase()

// ---------------------------------------------------------------------------
// 核心：扫描 digest → 生成笔记 → 与目标文件夹做增量对比
// ---------------------------------------------------------------------------

export function runImport(config = {}, opts = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) }
  const dryRun = opts.dryRun === true

  if (!fs.existsSync(cfg.remeDigestDir)) {
    throw new Error(`ReMe digest 目录不存在：${cfg.remeDigestDir}`)
  }
  const outDir = path.join(cfg.vaultDir, cfg.targetFolder)

  // 第一遍：读源文件、定标题与落点文件名（先定名才能改写链接）
  const sources = walkMarkdown(cfg.remeDigestDir).sort()
  const notes = []
  for (const abs of sources) {
    const raw = fs.readFileSync(abs, 'utf8')
    const { fmLines, body } = splitFrontmatter(raw)
    const rel = path.relative(cfg.remeDigestDir, abs).replace(/\\/g, '/')
    const slug = path.basename(abs, '.md')
    const title = readFmValue(fmLines, 'name') || firstHeading(body) || slug
    notes.push({
      abs,
      rel,
      slug,
      title,
      fmLines,
      body,
      category: rel.includes('/') ? rel.split('/')[0] : '',
    })
  }

  // 文件名去重（同名笔记加序号），并建立 slug / 标题 到文件名的索引供链接改写用
  const used = new Set([cfg.indexName.replace(/\.md$/i, '').toLowerCase()])
  const slugToFile = new Map()
  const fileNames = new Set()
  for (const note of notes) {
    const base = sanitizeFileName(note.title)
    let candidate = base
    let i = 2
    while (used.has(candidate.toLowerCase())) candidate = `${base} (${i++})`
    used.add(candidate.toLowerCase())
    note.fileName = candidate
    slugToFile.set(note.slug, candidate)
    fileNames.add(candidate)
  }
  const resolveTitle = (_target, base) =>
    slugToFile.get(base) || (fileNames.has(base) ? base : null)

  // 第二遍：组装目标内容并落盘
  const now = new Date().toISOString()
  const added = []
  const updated = []
  const skipped = []
  const written = new Set()

  if (!dryRun && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })

  for (const note of notes) {
    const raw = cfg.rewriteDanglingLinks ? rewriteLinks(note.body, resolveTitle) : note.body
    // 统一行尾为 LF 并剔除零宽字符：源文件是 CRLF，与模板的 LF 混排会在 Obsidian 里显出隐形字符
    const body = raw.replace(/\r\n?/g, '\n').replace(/\uFEFF/g, '')
    const kept = note.fmLines.filter((line) => !/^(source|category|imported_at)\s*:/.test(line))
    const fmOut = [
      ...kept,
      `source: ${quoteYaml(note.rel)}`,
      `category: ${quoteYaml(note.category)}`,
      `imported_at: ${quoteYaml(now)}`,
    ]
    const content = `---\n${fmOut.join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`
    const targetName = `${note.fileName}.md`
    const targetPath = path.join(outDir, targetName)

    written.add(targetName.toLowerCase())

    const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : null
    // 已存在且正文一致 → 仅刷新 imported_at 之外的差异视为无变化（正文比对忽略 imported_at 行）
    const sameAsBefore =
      existing !== null &&
      existing.replace(/^imported_at:.*$/m, '') === content.replace(/^imported_at:.*$/m, '')

    if (sameAsBefore) {
      skipped.push(targetName)
      continue
    }
    if (!dryRun) fs.writeFileSync(targetPath, content, 'utf8')
    if (existing === null) added.push(targetName)
    else updated.push(targetName)
  }

  // 清理：只动我们自己写出的、source 指向本 digest 的过期/改名文件
  const removed = []
  if (!dryRun && fs.existsSync(outDir)) {
    for (const ent of fs.readdirSync(outDir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.md')) continue
      if (ent.name.toLowerCase() === cfg.indexName.toLowerCase()) continue
      if (written.has(ent.name.toLowerCase())) continue
      const abs = path.join(outDir, ent.name)
      const { fmLines } = splitFrontmatter(fs.readFileSync(abs, 'utf8'))
      const src = readFmValue(fmLines, 'source')
      if (!src || !norm(path.join(cfg.remeDigestDir, src)).startsWith(norm(cfg.remeDigestDir))) continue
      fs.unlinkSync(abs)
      removed.push(ent.name)
    }
  }

  // 总索引
  const indexName = cfg.indexName
  if (!dryRun) {
    const groups = new Map()
    for (const note of notes) {
      const key = note.category || '其他'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(note)
    }
    const lines = [
      '---',
      `name: ReMe 知识库索引`,
      `source: ${quoteYaml(cfg.remeDigestDir)}`,
      `imported_at: ${quoteYaml(now)}`,
      '---',
      '',
      '# ReMe 知识库索引',
      '',
      `> 由 dsh-reme-obsidian 从 ReMe 工作区 \`digest/\` 导入，共 ${notes.length} 篇。`,
      '',
    ]
    for (const [key, items] of [...groups.entries()].sort()) {
      lines.push(`## ${key}`, '')
      for (const note of items) lines.push(`- [[${note.fileName}]] — ${note.title}`)
      lines.push('')
    }
    fs.writeFileSync(path.join(outDir, indexName), lines.join('\n'), 'utf8')
  }

  return {
    dryRun,
    outDir,
    total: notes.length,
    added,
    updated,
    skipped,
    removed,
  }
}

export function formatSummary(result) {
  const head = result.dryRun ? '【试运行】本次不会写入任何文件' : '已完成导入'
  const lines = [
    `${head}：ReMe digest → ${result.outDir}`,
    `源笔记 ${result.total} 篇｜新增 ${result.added.length}｜更新 ${result.updated.length}｜未变跳过 ${result.skipped.length}${result.removed.length ? `｜清理过期 ${result.removed.length}` : ''}`,
  ]
  if (result.added.length) lines.push('', `新增：${result.added.join('、')}`)
  if (result.updated.length) lines.push('', `更新：${result.updated.join('、')}`)
  if (result.removed.length) lines.push('', `已清理（源文件改名或删除）：${result.removed.join('、')}`)
  return lines.join('\n')
}

/** 给界面按钮用的短摘要（长文本只用于 agent 工具结果） */
export function formatShortSummary(result) {
  const parts = []
  if (result.added.length) parts.push(`新增 ${result.added.length}`)
  if (result.updated.length) parts.push(`更新 ${result.updated.length}`)
  if (result.removed.length) parts.push(`清理 ${result.removed.length}`)
  return parts.length ? parts.join(' · ') : '已是最新'
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const getConfig = () => ({ ...DEFAULT_CONFIG, ...(config || {}) })

  // 浏览器半（client.js）通过 Connection RPC 调用本插件的导入逻辑。
  // 用 exact fetch route 注册，而不是 interceptor：官方 dsh-api-gateway 独占 /api 共享通道，
  // 插件再 intercept 会把 gateway 挤掉、导致官方端点全部 404（同 dsh-skill-market 的踩坑注释）。
  if (ctx.connection?.fetch?.register) {
    ctx.connection.fetch.register({
      path: RPC_PATH,
      methods: ['POST'],
      fetch: async (request) => {
        let body = {}
        try {
          body = await request.json()
        } catch {
          return Response.json({
            type: 'server-response',
            rpcId: 'invalid-request',
            result: { ok: false, error: { code: 'bad-request', message: 'body is not JSON' } },
          })
        }
        const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request'
        try {
          const result = runImport(getConfig(), { dryRun: body?.payload?.dryRun === true })
          return Response.json({
            type: 'server-response',
            rpcId,
            result: { ok: true, value: formatShortSummary(result) },
          })
        } catch (error) {
          return Response.json({
            type: 'server-response',
            rpcId,
            result: { ok: false, error: { code: 'internal', message: error?.message || String(error) } },
          })
        }
      },
    })
  }

  ctx.tools.register(
    defineTool({
      name: 'reme_import_to_obsidian',
      description: [
        '把 ReMe 知识库（工作区 digest 目录下 AI 整理过的知识笔记）导入到 Obsidian 库的 ReMe/ 文件夹。',
        '增量执行：内容未变的笔记跳过，源文件改名或删除时清理对应的旧笔记，并刷新总索引。',
        '只在用户要求"把知识库同步/导入到 Obsidian"时调用。',
      ].join(' '),
      parameters: {
        dry_run: {
          type: 'boolean',
          description: '设为 true 时只统计将要新增/更新/清理的笔记，不写入任何文件。',
        },
      },
      execute: async (args) => formatSummary(runImport(getConfig(), { dryRun: args?.dry_run === true })),
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      presentCall: (args) => ({
        card: 'generic',
        kind: 'write',
        title: args?.dry_run ? 'ReMe → Obsidian（试运行）' : 'ReMe 知识库导入 Obsidian',
        rawInput: args,
      }),
    }),
  )

  console.log(`[reme-obsidian] ready: ${getConfig().remeDigestDir} → ${path.join(getConfig().vaultDir, getConfig().targetFolder)}`)
}

// 允许直接 `node index.js [--dry-run]` 单独跑一次导入，便于脱离 DSH 验证
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(formatSummary(runImport(DEFAULT_CONFIG, { dryRun: process.argv.includes('--dry-run') })))
  } catch (error) {
    console.error(`导入失败：${error?.message}`)
    process.exitCode = 1
  }
}
