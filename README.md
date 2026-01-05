# EVA Reader

一个在 VS Code 中阅读 txt 文档的插件。

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/jdeseva.eva-reader?label=VS%20Code%20Marketplace&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=jdeseva.eva-reader)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/jdeseva.eva-reader)](https://marketplace.visualstudio.com/items?itemName=jdeseva.eva-reader)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/jdeseva.eva-reader)](https://marketplace.visualstudio.com/items?itemName=jdeseva.eva-reader)
[![GitHub](https://img.shields.io/badge/GitHub-orange4moon/om--txt--reader-blue?logo=github)](https://github.com/orange4moon/om-txt-reader)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

## 📦 安装

### 方式 1：从 VS Code 市场安装（推荐）

1. 打开 VS Code
2. 按 `Cmd/Ctrl+Shift+X` 打开扩展视图
3. 搜索 `EVA Reader` 或 `jdeseva.eva-reader`
4. 点击 **"安装"** 按钮

或者点击这里直接安装：
[![Install](https://img.shields.io/badge/Install-EVA--Reader-blue?style=for-the-badge&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=jdeseva.eva-reader)

### 方式 2：通过命令行安装

```bash
code --install-extension jdeseva.eva-reader
```

### 方式 3：从 VSIX 文件安装

从 [Releases](https://github.com/orange4moon/om-txt-reader/releases) 下载最新的 `.vsix` 文件，然后在 VS Code 中从 VSIX 安装。

## 🚀 快速开始

### 首次使用

1. 按 `Cmd/Ctrl+Shift+P` 打开命令面板
2. 输入 **"eva-reader: 打开配置"**
3. 选择包含 txt 文档的目录
4. 配置默认的章节分割规则（可选）
5. 保存配置

### 开始阅读

1. 按 `Cmd/Ctrl+Shift+P` 打开命令面板
2. 输入 **"eva-reader: 打开阅读器"**
3. 在书架中点击任意文档开始阅读

## 📖 使用指南

### 命令列表

| 命令 | 说明 |
|-----|------|
| `eva-reader: 打开阅读器` | 打开阅读器 |
| `eva-reader: 打开配置` | 打开配置 |
| `eva-reader: 搜索文本` | 在当前文档中搜索文本 |
| `eva-reader: 显示章节列表` | 显示章节列表 |
| `eva-reader: 配置当前文档章节分割规则` | 为当前文档设置专属章节分割规则 |

### 快捷键

在阅读器激活时：

- `Cmd/Ctrl + PageDown`: 向下滚动
- `Cmd/Ctrl + PageUp`: 向上滚动
- `Cmd/Ctrl + F`: 搜索文本

### 章节分割规则

支持多种章节格式：

| 章节格式 | 正则表达式 | 示例 |
|---------|-----------|------|
| 第X章 标题 | `^第[0-9一二三四五六七八九十百千]+[章节]\\s+.+$` | 第一章 标题 |
| 数字、标题 | `^[0-9]+、.+$` | 1、标题 |
| 数字 标题 | `^[0-9]+\\s+.+$` | 1 标题 |
| 数字. 标题 | `^[0-9]+\\.\\s+.+$` | 1. 标题 |
| Chapter X | `^Chapter\\s+[0-9]+` | Chapter 1 |
| 包含"章" | `.*章.*` | 任何包含章字的行 |

## ⚙️ 配置选项

在 VS Code 设置中可以配置：

| 配置项 | 说明 | 默认值 |
|-------|------|--------|
| `evaReader.booksDirectory` | 文档目录 | "" |
| `evaReader.defaultChapterPattern` | 默认章节分割规则 | `^第[0-9一二三四五六七八九十百千]+[章节]\\s+.+$` |
| `evaReader.fontSize` | 阅读器字体大小（像素） | 16 |
| `evaReader.lineHeight` | 阅读器行高 | 1.8 |
| `evaReader.scrollStep` | 每次滚动的行数 | 3 |

## 🛠️ 开发

### 环境要求

- Node.js 20.x 或更高版本
- VS Code 1.74.0 或更高版本

### 构建

```bash
# 克隆仓库
git clone https://github.com/orange4moon/om-txt-reader.git
cd om-txt-reader

# 安装依赖
npm install

# 编译
npm run compile

# 调试
# 按 F5 启动调试模式
```

### 打包

```bash
npm run package
```

## 📄 许可证

[MIT License](./LICENSE)

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 💡 反馈

如有任何问题或建议，欢迎通过 [GitHub Issues](https://github.com/orange4moon/om-txt-reader/issues) 反馈。

---

Made with ❤️ by [orange4moon](https://github.com/orange4moon)
