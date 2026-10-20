# dsh-reme-obsidian

DeepSeek Harness 插件：把 [ReMe](https://github.com/agentscope-ai/ReMe) 知识库里已经整理好的 digest 笔记，一键导入 Obsidian 库的 `ReMe/` 文件夹。

## 做什么

- 读取 ReMe 工作区的 `digest/` 目录（AI 归纳后的知识笔记）
- 写入 Obsidian 库内的单一文件夹（默认 `ReMe/`），文件名取笔记 frontmatter 里的中文标题
- 合并 frontmatter：保留 ReMe 原有字段，追加 `source` / `category` / `imported_at`
- digest 中指向未导入笔记的 wikilink 自动改写为纯文本，避免在 Obsidian 里留下破链
- 生成总索引笔记（默认 `知识库索引.md`）
- 直接读工作区文件，**不依赖 ReMe 服务在线**

## 安装

```bash
npm i dsh-reme-obsidian
```

或在 DeepSeek Harness 的插件市场里安装。

## 使用

两种触发方式：

1. **设置页**：插件设置里点「导入知识库」
2. **对话中**：让 agent 调用 `reme_import_to_obsidian` 工具

## 配置

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `remeDigestDir` | `D:\AI\deepseek harness\reme-workspace\digest` | ReMe 工作区的 digest 目录 |
| `vaultDir` | `D:\repository\my` | Obsidian 库根目录 |
| `targetFolder` | `ReMe` | 库内目标文件夹名 |
| `indexName` | `知识库索引.md` | 总索引笔记文件名 |
| `rewriteDanglingLinks` | `true` | 是否把无法解析的 wikilink 改写成纯文本 |

## 许可

MIT
