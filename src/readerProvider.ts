import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { BookConfig, BookConfigManager } from "./bookConfig";

interface Chapter {
  name: string;
  line: number;
}

interface SearchResult {
  line: number;
  content: string;
}

interface ChunkCache {
  startLine: number;
  endLine: number;
  lines: string[];
}

export class TxtReaderProvider {
  private panel: vscode.WebviewPanel | undefined;
  private content: string = "";
  private lines: string[] = [];
  private currentLine: number = 0;
  private chapters: Chapter[] = [];
  private fileUri: vscode.Uri;
  private extensionUri: vscode.Uri;
  private bookConfig: BookConfig | null = null;
  private saveProgressTimer: NodeJS.Timeout | undefined;

  // 分块加载相关属性
  private fileSize: number = 0;
  private totalLines: number = 0;
  private useChunkMode: boolean = false;
  private chunkCache: Map<number, ChunkCache> = new Map(); // 缓存已加载的块

  constructor(extensionUri: vscode.Uri, fileUri: vscode.Uri) {
    this.extensionUri = extensionUri;
    this.fileUri = fileUri;
  }

  public async show(context: vscode.ExtensionContext) {
    // 初始化文件信息（文件大小、总行数等）
    await this.initializeFile();

    // 加载文档配置
    this.bookConfig = await BookConfigManager.loadConfig(this.fileUri.fsPath);
    if (this.bookConfig) {
      this.currentLine = this.bookConfig.progress;
    }

    // 创建并显示 webview
    this.panel = vscode.window.createWebviewPanel(
      "evaReader",
      path.basename(this.fileUri.fsPath),
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    // 设置 context
    vscode.commands.executeCommand("setContext", "evaReaderActive", true);

    // 异步扫描章节（不阻塞 UI）
    this.scanChaptersAsync();

    // 设置 webview 内容
    this.panel.webview.html = this.getWebviewContent();

    // 处理来自 webview 的消息
    this.panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.command) {
          case "scrollUp":
            this.scrollUp();
            break;
          case "scrollDown":
            this.scrollDown();
            break;
          case "jumpToLine":
            this.jumpToLine(message.line);
            break;
          case "search":
            this.searchAsync(message.text);
            break;
          case "jumpToChapter":
            this.jumpToLine(message.line);
            break;
          case "requestChapters":
            this.sendChaptersToWebview();
            break;
          case "updateProgress":
            this.updateProgress(message.line);
            break;
          case "requestInitialContent":
            this.sendInitialContent();
            break;
          case "requestChunk":
            this.sendChunk(message.startLine, message.endLine);
            break;
        }
      },
      undefined,
      context.subscriptions
    );

    // 监听 panel 关闭事件
    this.panel.onDidDispose(() => {
      vscode.commands.executeCommand("setContext", "evaReaderActive", false);
      this.saveProgressNow();
      if (this.saveProgressTimer) {
        clearTimeout(this.saveProgressTimer);
      }
      // 清理缓存
      this.chunkCache.clear();
      this.panel = undefined;
    });

    // 不在这里发送初始数据，等待 webview 请求（通过 requestInitialContent）
    // 这样可以确保 webview 已经完全加载并准备好接收消息
  }

  /**
   * 初始化文件信息（文件大小、总行数等）
   */
  private async initializeFile() {
    try {
      const stats = await fs.promises.stat(this.fileUri.fsPath);
      this.fileSize = stats.size;

      const config = vscode.workspace.getConfiguration("evaReader");
      const largeFileThreshold =
        config.get<number>("largeFileThreshold", 5) * 1024 * 1024; // 转换为字节

      // 如果文件较大，使用分块模式
      if (this.fileSize > largeFileThreshold) {
        this.useChunkMode = true;
        // 快速统计总行数（只读取换行符）
        await this.countTotalLines();
      } else {
        // 小文件直接加载
        this.useChunkMode = false;
        await this.loadFile();
      }
    } catch (error) {
      vscode.window.showErrorMessage(`无法读取文档: ${error}`);
    }
  }

  /**
   * 加载整个文件（小文件使用）
   */
  private async loadFile() {
    try {
      const buffer = await vscode.workspace.fs.readFile(this.fileUri);
      this.content = this.decodeBuffer(buffer);
      this.lines = this.content.split("\n");
      this.totalLines = this.lines.length;
    } catch (error) {
      vscode.window.showErrorMessage(`无法读取文档: ${error}`);
    }
  }

  /**
   * 快速统计文件总行数（通过读取换行符）
   */
  private async countTotalLines(): Promise<void> {
    return new Promise((resolve, reject) => {
      const stream = fs.createReadStream(this.fileUri.fsPath, {
        encoding: "utf8",
      });
      let lineCount = 0;
      let buffer = "";

      stream.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // 保留最后一个不完整的行
        lineCount += lines.length;
      });

      stream.on("end", () => {
        if (buffer.length > 0) {
          lineCount++; // 最后一行
        }
        this.totalLines = lineCount;
        resolve();
      });

      stream.on("error", (error) => {
        reject(error);
      });
    });
  }

  /**
   * 获取指定行范围的内容块
   */
  private async getChunk(
    startLine: number,
    endLine: number
  ): Promise<string[]> {
    // 确保参数有效
    if (startLine < 0) {
      startLine = 0;
    }
    if (endLine < startLine) {
      endLine = startLine;
    }
    if (endLine >= this.totalLines) {
      endLine = this.totalLines - 1;
    }

    console.log("getChunk:", {
      startLine,
      endLine,
      totalLines: this.totalLines,
    });

    // 检查缓存
    const cacheKey = Math.floor(startLine / 200) * 200; // 按块大小对齐
    const cached = this.chunkCache.get(cacheKey);
    if (cached && cached.startLine <= startLine && cached.endLine >= endLine) {
      // 从缓存中提取需要的行
      const startIdx = startLine - cached.startLine;
      const endIdx = endLine - cached.startLine + 1;
      const result = cached.lines.slice(startIdx, endIdx);
      console.log("getChunk from cache:", result.length);
      return result;
    }

    // 需要从文件读取
    // 先读取整个文件到缓冲区（这样可以正确处理编码）
    try {
      const buffer = await vscode.workspace.fs.readFile(this.fileUri);
      const content = this.decodeBuffer(buffer);
      const allLines = content.split("\n");

      // 确保总行数正确
      if (this.totalLines === 0 || this.totalLines !== allLines.length) {
        this.totalLines = allLines.length;
      }

      // 提取需要的行范围（注意：slice 的 end 是不包含的，所以需要 +1）
      const actualEndLine = Math.min(endLine + 1, allLines.length);
      const resultLines = allLines.slice(startLine, actualEndLine);

      console.log("getChunk from file:", {
        allLines: allLines.length,
        resultLines: resultLines.length,
        startLine,
        actualEndLine,
      });

      // 缓存这个块（缓存大小限制）
      const config = vscode.workspace.getConfiguration("evaReader");
      const chunkSize = config.get<number>("chunkSize", 200);
      if (this.chunkCache.size < 10 && resultLines.length > 0) {
        this.chunkCache.set(cacheKey, {
          startLine: startLine,
          endLine: startLine + resultLines.length - 1,
          lines: resultLines,
        });
      }

      return resultLines;
    } catch (error) {
      vscode.window.showErrorMessage(`读取文件块失败: ${error}`);
      console.error("getChunk error:", error);
      return [];
    }
  }

  /**
   * 发送内容块到 webview（用于滚动触发的加载）
   */
  private async sendChunk(startLine: number, endLine: number) {
    if (!this.panel) {
      return;
    }

    try {
      const lines = await this.getChunk(startLine, endLine);
      // 使用实际返回的行数计算 endLine
      const actualEndLine = lines.length > 0 ? startLine + lines.length - 1 : startLine;
      
      console.log("sendChunk:", {
        startLine,
        requestedEndLine: endLine,
        actualEndLine,
        linesCount: lines.length,
        totalLines: this.totalLines,
      });

      this.panel.webview.postMessage({
        command: "updateChunk",
        startLine: startLine,
        endLine: actualEndLine,
        lines: lines,
        totalLines: this.totalLines,
        isJump: false,
      });
    } catch (error) {
      vscode.window.showErrorMessage(`加载内容块失败: ${error}`);
    }
  }

  private decodeBuffer(buffer: Uint8Array): string {
    // 尝试 UTF-8
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      // 如果 UTF-8 失败，尝试 GBK
      try {
        return new TextDecoder("gbk").decode(buffer);
      } catch {
        // 如果都失败，使用默认解码
        return new TextDecoder().decode(buffer);
      }
    }
  }

  /**
   * 异步扫描章节（不阻塞 UI）
   */
  private async scanChaptersAsync() {
    this.chapters = [];
    const config = vscode.workspace.getConfiguration("evaReader");

    // 优先使用文档特定的规则，否则使用全局默认规则
    let patternStr = this.bookConfig?.chapterPattern;
    if (!patternStr) {
      patternStr = config.get<string>(
        "defaultChapterPattern",
        "^第[0-9一二三四五六七八九十百千]+[章节]\\s+.+$"
      );
    }

    try {
      const pattern = new RegExp(patternStr);

      // 如果使用分块模式，需要逐块扫描
      if (this.useChunkMode) {
        await this.scanChaptersInChunks(pattern);
      } else {
        // 小文件直接扫描
        for (let i = 0; i < this.lines.length; i++) {
          const line = this.lines[i].trim();
          if (pattern.test(line)) {
            this.chapters.push({
              name: line,
              line: i,
            });
          }
        }
        this.sendChaptersToWebview();
      }
    } catch (error) {
      vscode.window.showErrorMessage(`章节分割规则错误: ${error}`);
    }
  }

  /**
   * 分块扫描章节
   */
  private async scanChaptersInChunks(pattern: RegExp) {
    const chunkSize = 1000; // 每次处理 1000 行
    let processedLines = 0;

    // 通知 webview 开始扫描
    if (this.panel) {
      this.panel.webview.postMessage({
        command: "chapterScanProgress",
        progress: 0,
        total: this.totalLines,
      });
    }

    // 读取文件并逐块处理
    return new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(this.fileUri.fsPath, {
        encoding: "utf8",
      });
      let buffer = "";
      let lineNumber = 0;

      stream.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (pattern.test(trimmed)) {
            this.chapters.push({
              name: trimmed,
              line: lineNumber,
            });
          }
          lineNumber++;
          processedLines++;

          // 每处理一定数量后，让出控制权
          if (processedLines % chunkSize === 0) {
            setImmediate(() => {
              if (this.panel) {
                this.panel.webview.postMessage({
                  command: "chapterScanProgress",
                  progress: processedLines,
                  total: this.totalLines,
                });
              }
            });
          }
        }
      });

      stream.on("end", () => {
        // 处理最后一行
        if (buffer.trim()) {
          const trimmed = buffer.trim();
          if (pattern.test(trimmed)) {
            this.chapters.push({
              name: trimmed,
              line: lineNumber,
            });
          }
        }

        // 发送完成消息
        if (this.panel) {
          this.panel.webview.postMessage({
            command: "chapterScanComplete",
            chapters: this.chapters,
          });
        }
        resolve();
      });

      stream.on("error", (error) => {
        reject(error);
      });
    });
  }

  private scanChapters() {
    // 保持向后兼容，但实际使用异步版本
    this.scanChaptersAsync();
  }

  public reloadChapters() {
    this.scanChapters();
    this.sendChaptersToWebview();
    vscode.window.showInformationMessage(
      `已识别 ${this.chapters.length} 个章节`
    );
  }

  public scrollUp() {
    const config = vscode.workspace.getConfiguration("evaReader");
    const step = config.get<number>("scrollStep", 3);
    this.currentLine = Math.max(0, this.currentLine - step);
    this.updateWebview();
  }

  public scrollDown() {
    const config = vscode.workspace.getConfiguration("evaReader");
    const step = config.get<number>("scrollStep", 3);
    const maxLine = this.useChunkMode
      ? this.totalLines - 1
      : this.lines.length - 1;
    this.currentLine = Math.min(maxLine, this.currentLine + step);
    this.updateWebview();
  }

  public jumpToLine(line: number) {
    const maxLine = this.useChunkMode
      ? this.totalLines - 1
      : this.lines.length - 1;
    if (line >= 0 && line <= maxLine) {
      this.currentLine = line;

      // 如果使用分块模式，先加载内容块，然后通知前端滚动
      if (this.useChunkMode && this.panel) {
        const config = vscode.workspace.getConfiguration("evaReader");
        const bufferLines = config.get<number>("bufferLines", 50);
        const startLine = Math.max(0, line - bufferLines);
        const endLine = Math.min(this.totalLines - 1, line + bufferLines);

        // 发送内容块，并标记这是跳转操作
        this.sendChunkForJump(startLine, endLine, line);
      } else {
        // 传统模式直接更新
        this.updateWebview();
      }
    }
  }

  /**
   * 发送内容块用于跳转（标记为跳转操作）
   */
  private async sendChunkForJump(
    startLine: number,
    endLine: number,
    targetLine: number
  ) {
    if (!this.panel) {
      return;
    }

    try {
      const lines = await this.getChunk(startLine, endLine);
      // 使用实际返回的行数计算 endLine
      const actualEndLine = lines.length > 0 ? startLine + lines.length - 1 : startLine;
      
      console.log("sendChunkForJump:", {
        startLine,
        requestedEndLine: endLine,
        actualEndLine,
        linesCount: lines.length,
        targetLine,
        totalLines: this.totalLines,
      });

      this.panel.webview.postMessage({
        command: "updateChunk",
        startLine: startLine,
        endLine: actualEndLine,
        lines: lines,
        totalLines: this.totalLines,
        isJump: true,
        targetLine: targetLine,
      });
    } catch (error) {
      vscode.window.showErrorMessage(`加载内容块失败: ${error}`);
    }
  }

  /**
   * 异步搜索（支持大文件）
   */
  public async searchAsync(searchTerm: string) {
    const results: SearchResult[] = [];
    const maxResults = 1000; // 限制最大结果数

    if (this.useChunkMode) {
      // 分块搜索
      await this.searchInChunks(searchTerm, results, maxResults);
    } else {
      // 小文件直接搜索
      for (let i = 0; i < this.lines.length; i++) {
        if (this.lines[i].includes(searchTerm)) {
          results.push({
            line: i,
            content: this.lines[i].trim(),
          });
          if (results.length >= maxResults) {
            break;
          }
        }
      }

      if (this.panel) {
        this.panel.webview.postMessage({
          command: "searchResults",
          results: results,
          searchTerm: searchTerm,
          hasMore: results.length >= maxResults,
        });
      }
    }

    if (results.length === 0) {
      vscode.window.showInformationMessage(`未找到 "${searchTerm}"`);
    } else {
      vscode.window.showInformationMessage(
        `找到 ${results.length} 个匹配结果${
          results.length >= maxResults ? "（已限制显示数量）" : ""
        }`
      );
    }
  }

  /**
   * 分块搜索
   */
  private async searchInChunks(
    searchTerm: string,
    results: SearchResult[],
    maxResults: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const stream = fs.createReadStream(this.fileUri.fsPath, {
        encoding: "utf8",
      });
      let buffer = "";
      let lineNumber = 0;
      const chunkSize = 1000;

      stream.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.includes(searchTerm)) {
            results.push({
              line: lineNumber,
              content: line.trim(),
            });

            // 定期更新搜索结果
            if (results.length % 10 === 0 && this.panel) {
              this.panel.webview.postMessage({
                command: "searchResults",
                results: results.slice(0, Math.min(100, results.length)),
                searchTerm: searchTerm,
                hasMore: results.length < maxResults ? false : true,
                progress: lineNumber,
                total: this.totalLines,
              });
            }

            if (results.length >= maxResults) {
              stream.destroy();
              break;
            }
          }
          lineNumber++;
        }

        // 每处理一定数量后让出控制权
        if (lineNumber % chunkSize === 0) {
          setImmediate(() => {});
        }
      });

      stream.on("end", () => {
        // 处理最后一行
        if (buffer.includes(searchTerm)) {
          results.push({
            line: lineNumber,
            content: buffer.trim(),
          });
        }

        if (this.panel) {
          this.panel.webview.postMessage({
            command: "searchResults",
            results: results.slice(0, Math.min(100, results.length)),
            searchTerm: searchTerm,
            hasMore: false,
            totalResults: results.length,
          });
        }
        resolve();
      });

      stream.on("error", (error) => {
        reject(error);
      });
    });
  }

  public search(searchTerm: string) {
    // 保持向后兼容
    this.searchAsync(searchTerm);
  }

  public showChapters() {
    if (this.chapters.length === 0) {
      vscode.window.showInformationMessage(
        "未识别到任何章节，请配置章节分割规则"
      );
      return;
    }

    this.sendChaptersToWebview();
  }

  private sendChaptersToWebview() {
    if (this.panel) {
      this.panel.webview.postMessage({
        command: "updateChapters",
        chapters: this.chapters,
      });
    }
  }

  private async sendInitialContent() {
    if (!this.panel) {
      console.error("Panel is not available");
      return;
    }

    const config = vscode.workspace.getConfiguration("evaReader");
    const bufferLines = config.get<number>("bufferLines", 50);
    const enableVirtualScroll = config.get<boolean>(
      "enableVirtualScroll",
      true
    );

    console.log("sendInitialContent:", {
      useChunkMode: this.useChunkMode,
      enableVirtualScroll,
      totalLines: this.totalLines,
      currentLine: this.currentLine,
      linesLength: this.lines.length,
    });

    // 根据配置决定使用虚拟滚动还是传统模式
    if (this.useChunkMode && enableVirtualScroll) {
      // 分块模式 + 虚拟滚动：只发送初始可见区域
      const startLine = Math.max(0, this.currentLine - bufferLines);
      const endLine = Math.min(
        this.totalLines - 1,
        this.currentLine + bufferLines
      );

      console.log("Loading chunk (virtual scroll):", {
        startLine,
        endLine,
        totalLines: this.totalLines,
      });
      const initialLines = await this.getChunk(startLine, endLine);
      // 使用实际返回的行数计算 endLine
      const actualEndLine = initialLines.length > 0 ? startLine + initialLines.length - 1 : startLine;
      console.log("Loaded lines:", {
        count: initialLines.length,
        startLine,
        requestedEndLine: endLine,
        actualEndLine,
      });

      if (initialLines.length === 0) {
        vscode.window.showWarningMessage("无法加载文件内容，请检查文件编码");
      }

      this.panel.webview.postMessage({
        command: "initContent",
        useVirtualScroll: true,
        lines: initialLines,
        startLine: startLine,
        endLine: actualEndLine,
        currentLine: this.currentLine,
        totalLines: this.totalLines,
      });
    } else {
      // 传统模式：发送所有行（小文件或禁用虚拟滚动时）
      if (this.lines.length === 0) {
        // 如果还没加载，先加载
        if (this.useChunkMode) {
          // 大文件但禁用虚拟滚动，加载初始块
          const startLine = Math.max(0, this.currentLine - bufferLines);
          const endLine = Math.min(
            this.totalLines - 1,
            this.currentLine + bufferLines
          );
          this.lines = await this.getChunk(startLine, endLine);
        }
        // 小文件已经在 loadFile() 中加载了
      }

      console.log("Sending all lines (traditional mode):", this.lines.length);

      this.panel.webview.postMessage({
        command: "initContent",
        useVirtualScroll: false,
        allLines: this.lines,
        currentLine: this.currentLine,
        totalLines: this.useChunkMode ? this.totalLines : this.lines.length,
      });
    }

    this.sendChaptersToWebview();
  }

  private updateWebview() {
    if (this.panel) {
      this.panel.webview.postMessage({
        command: "updateScroll",
        currentLine: this.currentLine,
      });
    }
  }

  private updateProgress(line: number) {
    this.currentLine = line;

    // 延迟保存进度，避免频繁写入
    if (this.saveProgressTimer) {
      clearTimeout(this.saveProgressTimer);
    }

    this.saveProgressTimer = setTimeout(() => {
      this.saveProgressNow();
    }, 2000); // 2秒后保存
  }

  private async saveProgressNow() {
    if (this.fileUri) {
      const totalLines = this.useChunkMode
        ? this.totalLines
        : this.lines.length;
      await BookConfigManager.updateProgress(
        this.fileUri.fsPath,
        this.currentLine,
        totalLines
      );
    }
  }

  private getWebviewContent(): string {
    const config = vscode.workspace.getConfiguration("evaReader");
    const fontSize = config.get<number>("fontSize", 16);
    const lineHeight = config.get<number>("lineHeight", 1.8);

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>EVA Reader</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Microsoft YaHei', '微软雅黑', Arial, sans-serif;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        
        .container {
            display: flex;
            height: 100%;
            overflow: hidden;
        }
        
        .sidebar {
            width: 250px;
            flex-shrink: 0;
            background-color: var(--vscode-sideBar-background);
            border-right: 1px solid var(--vscode-panel-border);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            transition: margin-left 0.3s ease, opacity 0.3s ease;
        }
        
        .sidebar.hidden {
            margin-left: -250px;
            opacity: 0;
            pointer-events: none;
        }
        
        .sidebar-tabs {
            display: flex;
            border-bottom: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
        }
        
        .sidebar-tab {
            flex: 1;
            padding: 10px;
            text-align: center;
            cursor: pointer;
            background-color: var(--vscode-tab-inactiveBackground);
            border: none;
            color: var(--vscode-tab-inactiveForeground);
        }
        
        .sidebar-tab.active {
            background-color: var(--vscode-tab-activeBackground);
            color: var(--vscode-tab-activeForeground);
            border-bottom: 2px solid var(--vscode-focusBorder);
        }
        
        .sidebar-content {
            flex: 1;
            overflow-y: auto;
            padding: 10px;
        }
        
        .tab-panel {
            display: none;
        }
        
        .tab-panel.active {
            display: block;
        }
        
        .main-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        
        .toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 20px;
            background-color: var(--vscode-editorWidget-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
        }
        
        .current-chapter-display {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 14px;
            font-weight: 500;
            color: var(--vscode-editor-foreground);
        }
        
        .chapter-icon {
            font-size: 16px;
        }
        
        #current-chapter-name {
            color: var(--vscode-textLink-foreground);
        }
        
        .progress-info {
            margin-left: auto;
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }
        
        .content-area {
            flex: 1;
            padding: 30px 50px;
            overflow-y: auto;
            overflow-x: hidden;
            line-height: ${lineHeight};
            font-size: ${fontSize}px;
            white-space: pre-wrap;
            word-wrap: break-word;
            scroll-behavior: smooth;
            position: relative;
        }
        
        .content-line {
            min-height: 1em;
        }
        
        .virtual-scroll-container {
            position: relative;
        }
        
        .virtual-scroll-spacer {
            width: 100%;
            pointer-events: none;
            flex-shrink: 0;
        }
        
        .loading-indicator {
            text-align: center;
            padding: 20px;
            color: var(--vscode-descriptionForeground);
            font-size: 13px;
        }
        
        .chapter-item {
            padding: 8px 12px;
            cursor: pointer;
            border-radius: 3px;
            margin-bottom: 5px;
            font-size: 13px;
            transition: background-color 0.2s;
        }
        
        .chapter-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        
        .chapter-item.active {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
        
        .chapter-item.active .chapter-name {
            color: var(--vscode-list-activeSelectionForeground);
        }
        
        .chapter-item.active .chapter-line {
            color: var(--vscode-list-activeSelectionForeground);
            opacity: 0.8;
        }
        
        .chapter-name {
            font-weight: bold;
            margin-bottom: 2px;
        }
        
        .chapter-line {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        
        .search-result-item {
            padding: 8px 12px;
            cursor: pointer;
            border-radius: 3px;
            margin-bottom: 5px;
            font-size: 12px;
        }
        
        .search-result-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        
        .search-line {
            color: var(--vscode-textLink-foreground);
            font-weight: bold;
            margin-bottom: 3px;
        }
        
        .search-content {
            color: var(--vscode-descriptionForeground);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        
        .search-highlight {
            background-color: var(--vscode-editor-findMatchHighlightBackground);
            color: var(--vscode-editor-foreground);
            padding: 1px 2px;
        }
        
        .empty-message {
            text-align: center;
            color: var(--vscode-descriptionForeground);
            padding: 20px;
            font-size: 13px;
        }

        .search-input-container {
            margin-bottom: 10px;
        }

        .search-input {
            width: 100%;
            padding: 6px 10px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            font-size: 13px;
            margin-bottom: 8px;
        }

        .search-button {
            width: 100%;
            padding: 6px 12px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 13px;
        }

        .search-button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .sidebar-toggle {
            position: fixed;
            left: 0;
            top: 50%;
            transform: translateY(-50%);
            width: 24px;
            height: 60px;
            background-color: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-left: none;
            border-radius: 0 12px 12px 0;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 100;
            transition: all 0.3s ease;
            opacity: 0.6;
        }
        
        .sidebar-toggle:hover {
            opacity: 1;
            width: 28px;
        }
        
        .sidebar-toggle.sidebar-visible {
            left: 250px;
        }
        
        .toggle-icon {
            font-size: 14px;
            transition: transform 0.3s ease;
        }
        
        .sidebar-toggle.sidebar-visible .toggle-icon {
            transform: rotate(180deg);
        }
    </style>
</head>
<body>
    <div class="sidebar-toggle" id="sidebar-toggle" onclick="toggleSidebar()">
        <span class="toggle-icon">▶</span>
    </div>
    
    <div class="container">
        <div class="sidebar" id="sidebar">
            <div class="sidebar-tabs">
                <button class="sidebar-tab active" data-tab="chapters">章节</button>
                <button class="sidebar-tab" data-tab="search">搜索</button>
            </div>
            <div class="sidebar-content">
                <div id="chapters-panel" class="tab-panel active">
                    <div id="chapters-list"></div>
                </div>
                <div id="search-panel" class="tab-panel">
                    <div class="search-input-container">
                        <input type="text" id="search-input" class="search-input" placeholder="输入搜索内容...">
                        <button onclick="doSearch()" class="search-button">搜索</button>
                    </div>
                    <div id="search-results"></div>
                </div>
            </div>
        </div>
        
        <div class="main-content">
            <div class="toolbar">
                <div class="current-chapter-display" id="current-chapter-display">
                    <span class="chapter-icon">📖</span>
                    <span id="current-chapter-name">未识别章节</span>
                </div>
                <span class="progress-info">
                    第 <span id="current-line">0</span> 行 / 共 <span id="total-lines">0</span> 行
                    (<span id="progress-percent">0</span>%)
                </span>
            </div>
            <div class="content-area" id="content"></div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let allLines = [];
        let currentLine = 0;
        let totalLines = 0;
        let allChapters = [];
        let sidebarVisible = true;
        let isInitialLoad = true; // 标记是否是初次加载
        
        // 虚拟滚动相关变量
        let useVirtualScroll = false;
        let lineHeight = ${lineHeight};
        let fontSize = ${fontSize};
        let bufferLines = 50; // 缓冲区行数
        let visibleStartLine = 0;
        let visibleEndLine = 0;
        let loadedStartLine = 0;
        let loadedEndLine = 0;
        let lineHeightPx = 0; // 每行的实际像素高度
        let scrollContainer = null;
        let contentContainer = null;
        let loadingChunk = false;
        
        // 标签页切换
        document.querySelectorAll('.sidebar-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.getAttribute('data-tab');
                
                document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                
                document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
                document.getElementById(tabName + '-panel').classList.add('active');
            });
        });
        
        function toggleSidebar() {
            sidebarVisible = !sidebarVisible;
            const sidebar = document.getElementById('sidebar');
            const toggle = document.getElementById('sidebar-toggle');
            
            if (sidebarVisible) {
                sidebar.classList.remove('hidden');
                toggle.classList.add('sidebar-visible');
            } else {
                sidebar.classList.add('hidden');
                toggle.classList.remove('sidebar-visible');
            }
        }
        
        function doSearch() {
            const text = document.getElementById('search-input').value;
            if (text) {
                vscode.postMessage({ command: 'search', text: text });
            }
        }
        
        document.getElementById('search-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                doSearch();
            }
        });
        
        // 初始化虚拟滚动
        function initVirtualScroll() {
            if (!scrollContainer) {
                scrollContainer = document.getElementById('content');
                contentContainer = scrollContainer;
            }
            
            if (!scrollContainer) {
                console.error('无法找到 content 容器');
                return;
            }
            
            // 计算行高（如果还没有计算）
            if (lineHeightPx === 0) {
                const testLine = document.createElement('div');
                testLine.className = 'content-line';
                testLine.style.visibility = 'hidden';
                testLine.style.position = 'absolute';
                testLine.style.pointerEvents = 'none';
                testLine.textContent = '测试';
                scrollContainer.appendChild(testLine);
                lineHeightPx = testLine.offsetHeight || (fontSize * lineHeight);
                scrollContainer.removeChild(testLine);
                
                // 如果还是 0，使用配置值计算
                if (lineHeightPx === 0) {
                    lineHeightPx = fontSize * lineHeight;
                }
            }
            
            // 监听滚动事件（避免重复绑定）
            if (!scrollContainer.hasAttribute('data-scroll-listener')) {
                scrollContainer.setAttribute('data-scroll-listener', 'true');
                let scrollTimeout;
                scrollContainer.addEventListener('scroll', () => {
                    clearTimeout(scrollTimeout);
                    scrollTimeout = setTimeout(() => {
                        handleScroll();
                    }, 16); // 约 60fps
                });
            }
        }
        
        // 处理滚动事件
        let pendingChunkRequest = null;
        function handleScroll() {
            if (!useVirtualScroll) {
                // 传统模式
                const lines = document.querySelectorAll('.content-line');
                const containerRect = scrollContainer.getBoundingClientRect();
                
                for (let i = 0; i < lines.length; i++) {
                    const lineRect = lines[i].getBoundingClientRect();
                    if (lineRect.bottom > containerRect.top + 50) {
                        const lineNum = parseInt(lines[i].getAttribute('data-line'));
                        updateProgressInfo(lineNum);
                        vscode.postMessage({ command: 'updateProgress', line: lineNum });
                        break;
                    }
                }
                return;
            }
            
            // 虚拟滚动模式
            const scrollTop = scrollContainer.scrollTop;
            const containerHeight = scrollContainer.clientHeight;
            
            // 计算可见区域
            const visibleStart = Math.max(0, Math.floor(scrollTop / lineHeightPx) - bufferLines);
            const visibleEnd = Math.min(totalLines - 1, Math.ceil((scrollTop + containerHeight) / lineHeightPx) + bufferLines);
            
            // 如果可见区域超出已加载范围，请求新的块
            if (visibleStart < loadedStartLine || visibleEnd > loadedEndLine) {
                if (!loadingChunk) {
                    loadingChunk = true;
                    const requestStart = Math.max(0, visibleStart - bufferLines * 2);
                    const requestEnd = Math.min(totalLines - 1, visibleEnd + bufferLines * 2);
                    
                    // 取消之前的请求
                    if (pendingChunkRequest) {
                        clearTimeout(pendingChunkRequest);
                    }
                    
                    // 延迟请求，避免快速滚动时频繁请求
                    pendingChunkRequest = setTimeout(() => {
                        vscode.postMessage({ 
                            command: 'requestChunk', 
                            startLine: requestStart, 
                            endLine: requestEnd 
                        });
                        pendingChunkRequest = null;
                    }, 50);
                }
            }
            
            // 更新当前行（节流）
            const currentVisibleLine = Math.floor((scrollTop + containerHeight / 2) / lineHeightPx);
            if (currentVisibleLine >= 0 && currentVisibleLine < totalLines) {
                updateProgressInfo(currentVisibleLine);
            }
        }
        
        // 渲染虚拟滚动内容
        function renderVirtualContent(lines, startLine, endLine) {
            if (!useVirtualScroll) {
                console.log('renderVirtualContent: useVirtualScroll is false');
                return;
            }
            
            console.log('renderVirtualContent:', { lines: lines.length, startLine, endLine, totalLines });
            
            // 确保 scrollContainer 已初始化
            if (!scrollContainer) {
                scrollContainer = document.getElementById('content');
            }
            
            const container = scrollContainer || document.getElementById('content');
            if (!container) {
                console.error('无法找到 content 容器');
                return;
            }
            
            // 确保 lineHeightPx 已初始化
            if (lineHeightPx === 0) {
                // 先创建一个测试行来计算行高
                const testLine = document.createElement('div');
                testLine.className = 'content-line';
                testLine.style.visibility = 'hidden';
                testLine.style.position = 'absolute';
                testLine.style.pointerEvents = 'none';
                testLine.textContent = '测试';
                container.appendChild(testLine);
                lineHeightPx = testLine.offsetHeight || (fontSize * lineHeight);
                container.removeChild(testLine);
                
                // 如果还是 0，使用配置值计算
                if (lineHeightPx === 0) {
                    lineHeightPx = fontSize * lineHeight;
                }
                console.log('Calculated lineHeightPx:', lineHeightPx);
            }
            
            const fragment = document.createDocumentFragment();
            
            // 创建顶部占位符
            if (startLine > 0 && lineHeightPx > 0) {
                const topSpacer = document.createElement('div');
                topSpacer.className = 'virtual-scroll-spacer';
                const topHeight = startLine * lineHeightPx;
                topSpacer.style.height = topHeight + 'px';
                topSpacer.style.minHeight = topHeight + 'px';
                topSpacer.style.display = 'block';
                fragment.appendChild(topSpacer);
                console.log('Top spacer created:', { height: topHeight, startLine });
            }
            
            // 创建内容行
            if (lines && lines.length > 0) {
                console.log('Creating content lines:', lines.length);
                lines.forEach((line, index) => {
                    const lineNum = startLine + index;
                    const lineDiv = document.createElement('div');
                    lineDiv.className = 'content-line';
                    lineDiv.setAttribute('data-line', lineNum);
                    // 确保文本内容不为空
                    const textContent = line !== undefined && line !== null ? String(line) : ' ';
                    lineDiv.textContent = textContent;
                    lineDiv.style.display = 'block';
                    fragment.appendChild(lineDiv);
                });
                console.log('Content lines created, fragment children:', fragment.children.length);
            } else {
                console.warn('No lines to render!', { lines, linesLength: lines ? lines.length : 0 });
            }
            
            // 创建底部占位符
            const remainingLines = totalLines - endLine - 1;
            if (remainingLines > 0 && lineHeightPx > 0) {
                const bottomSpacer = document.createElement('div');
                bottomSpacer.className = 'virtual-scroll-spacer';
                const bottomHeight = remainingLines * lineHeightPx;
                bottomSpacer.style.height = bottomHeight + 'px';
                bottomSpacer.style.minHeight = bottomHeight + 'px';
                bottomSpacer.style.display = 'block';
                fragment.appendChild(bottomSpacer);
                console.log('Bottom spacer created:', { height: bottomHeight, remainingLines });
            }
            
            // 清空并更新内容
            console.log('Before clearing container, children:', container.children.length);
            container.innerHTML = '';
            console.log('After clearing container, children:', container.children.length);
            console.log('Fragment children before append:', fragment.children.length);
            
            container.appendChild(fragment);
            
            // 验证内容是否正确添加
            const contentLines = container.querySelectorAll('.content-line');
            const spacers = container.querySelectorAll('.virtual-scroll-spacer');
            
            // 等待 DOM 更新
            setTimeout(() => {
                const finalContentLines = container.querySelectorAll('.content-line');
                const finalSpacers = container.querySelectorAll('.virtual-scroll-spacer');
                
                console.log('Rendered content (after DOM update):', { 
                    containerChildren: container.children.length,
                    contentLines: finalContentLines.length,
                    spacers: finalSpacers.length,
                    loadedStartLine: startLine,
                    loadedEndLine: endLine,
                    lineHeightPx: lineHeightPx,
                    topSpacerHeight: startLine > 0 ? (startLine * lineHeightPx) + 'px' : 'none',
                    bottomSpacerHeight: (totalLines - endLine - 1) > 0 ? ((totalLines - endLine - 1) * lineHeightPx) + 'px' : 'none',
                    containerScrollHeight: container.scrollHeight,
                    containerClientHeight: container.clientHeight,
                    containerOffsetHeight: container.offsetHeight
                });
                
                // 如果内容行数为 0，输出警告
                if (finalContentLines.length === 0 && lines.length > 0) {
                    console.error('ERROR: Content lines not rendered!', {
                        linesToRender: lines.length,
                        startLine,
                        endLine,
                        fragmentChildren: fragment.children.length,
                        containerHTML: container.innerHTML.substring(0, 500),
                        containerStyle: window.getComputedStyle(container).display
                    });
                } else if (finalContentLines.length > 0) {
                    // 验证第一行和最后一行的内容
                    const firstLine = finalContentLines[0];
                    const lastLine = finalContentLines[finalContentLines.length - 1];
                    console.log('First line:', {
                        dataLine: firstLine.getAttribute('data-line'),
                        textContent: firstLine.textContent.substring(0, 50),
                        offsetHeight: firstLine.offsetHeight,
                        offsetTop: firstLine.offsetTop,
                        visible: firstLine.offsetParent !== null
                    });
                    console.log('Last line:', {
                        dataLine: lastLine.getAttribute('data-line'),
                        textContent: lastLine.textContent.substring(0, 50),
                        offsetHeight: lastLine.offsetHeight,
                        offsetTop: lastLine.offsetTop,
                        visible: lastLine.offsetParent !== null
                    });
                }
            }, 0);
            
            loadedStartLine = startLine;
            loadedEndLine = endLine;
            loadingChunk = false;
        }
        
        let progressUpdateTimer = null;
        function updateProgressInfo(line) {
            currentLine = line;
            document.getElementById('current-line').textContent = line;
            const percent = totalLines > 0 ? Math.round((line / totalLines) * 100) : 0;
            document.getElementById('progress-percent').textContent = percent;
            
            // 更新当前章节显示和高亮
            updateCurrentChapter(line, false); // 滚动时不自动定位
            
            // 节流发送进度更新
            if (progressUpdateTimer) {
                clearTimeout(progressUpdateTimer);
            }
            progressUpdateTimer = setTimeout(() => {
                vscode.postMessage({ command: 'updateProgress', line: line });
            }, 500); // 500ms 节流
        }
        
        function updateCurrentChapter(line, shouldScroll = false) {
            // 找到当前行所在的章节
            let currentChapter = null;
            let currentChapterIndex = -1;
            
            for (let i = allChapters.length - 1; i >= 0; i--) {
                if (line >= allChapters[i].line) {
                    currentChapter = allChapters[i];
                    currentChapterIndex = i;
                    break;
                }
            }
            
            // 更新工具栏显示
            const chapterNameEl = document.getElementById('current-chapter-name');
            if (currentChapter) {
                chapterNameEl.textContent = currentChapter.name;
            } else {
                chapterNameEl.textContent = '未识别章节';
            }
            
            // 更新章节列表高亮
            document.querySelectorAll('.chapter-item').forEach((item, index) => {
                if (index === currentChapterIndex) {
                    item.classList.add('active');
                    // 只在需要时自动滚动到当前激活的章节
                    if (shouldScroll) {
                        setTimeout(() => {
                            item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                        }, 100);
                    }
                } else {
                    item.classList.remove('active');
                }
            });
        }
        
        function scrollToLine(lineNum) {
            if (useVirtualScroll) {
                // 虚拟滚动模式：确保该行已加载
                if (lineNum < loadedStartLine || lineNum > loadedEndLine) {
                    // 如果行不在已加载范围内，请求新的块
                    const requestStart = Math.max(0, lineNum - bufferLines * 2);
                    const requestEnd = Math.min(totalLines - 1, lineNum + bufferLines * 2);
                    vscode.postMessage({ 
                        command: 'requestChunk', 
                        startLine: requestStart, 
                        endLine: requestEnd 
                    });
                    // 等待内容加载完成后再滚动（在 updateChunk 中处理）
                    return;
                }
                
                // 如果行已在范围内，直接滚动
                const scrollTop = lineNum * lineHeightPx;
                scrollContainer.scrollTop = scrollTop;
                updateProgressInfo(lineNum);
            } else {
                // 传统模式
                const lineElement = document.querySelector(\`.content-line[data-line="\${lineNum}"]\`);
                if (lineElement) {
                    lineElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    updateProgressInfo(lineNum);
                }
            }
        }
        
        // 监听来自扩展的消息
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
                case 'initContent':
                    useVirtualScroll = message.useVirtualScroll || false;
                    totalLines = message.totalLines || message.allLines?.length || 0;
                    currentLine = message.currentLine || 0;
                    
                    console.log('initContent:', { useVirtualScroll, totalLines, currentLine, hasLines: !!message.lines, hasAllLines: !!message.allLines });
                    
                    if (useVirtualScroll) {
                        // 虚拟滚动模式
                        allLines = message.lines || [];
                        visibleStartLine = message.startLine || 0;
                        visibleEndLine = message.endLine || (allLines.length - 1);
                        loadedStartLine = visibleStartLine;
                        loadedEndLine = visibleEndLine;
                        
                        console.log('Virtual scroll mode:', { allLines: allLines.length, startLine: visibleStartLine, endLine: visibleEndLine });
                        
                        // 先初始化虚拟滚动（计算行高等）
                        initVirtualScroll();
                        // 然后渲染内容
                        renderVirtualContent(allLines, visibleStartLine, visibleEndLine);
                    } else {
                        // 传统模式
                        allLines = message.allLines || [];
                        console.log('Traditional mode:', { allLines: allLines.length });
                        const contentEl = document.getElementById('content');
                        if (contentEl) {
                            contentEl.innerHTML = 
                                allLines.map((line, index) => 
                                    \`<div class="content-line" data-line="\${index}">\${escapeHtml(line) || '&nbsp;'}</div>\`
                                ).join('');
                        }
                    }
                    
                    const totalLinesEl = document.getElementById('total-lines');
                    if (totalLinesEl) {
                        totalLinesEl.textContent = totalLines;
                    }
                    
                    // 滚动到保存的位置
                    setTimeout(() => {
                        scrollToLine(currentLine);
                    }, 100);
                    break;
                    
                case 'updateChunk':
                    // 更新内容块（虚拟滚动）
                    if (useVirtualScroll) {
                        const newLines = message.lines || [];
                        const startLine = message.startLine || 0;
                        const endLine = message.endLine !== undefined ? message.endLine : (startLine + newLines.length - 1);
                        const isJump = message.isJump || false;
                        const targetLine = message.targetLine !== undefined ? message.targetLine : currentLine;
                        
                        // 更新 totalLines（如果提供了）
                        if (message.totalLines !== undefined) {
                            totalLines = message.totalLines;
                        }
                        
                        console.log('updateChunk:', { 
                            newLines: newLines.length, 
                            newLinesSample: newLines.slice(0, 3),
                            startLine, 
                            endLine, 
                            isJump, 
                            targetLine,
                            totalLines: message.totalLines,
                            currentTotalLines: totalLines
                        });
                        
                        // 验证数据
                        if (newLines.length === 0) {
                            console.error('ERROR: updateChunk received empty lines array!');
                            return;
                        }
                        
                        // 保存当前滚动位置
                        const oldScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
                        
                        console.log('Before renderVirtualContent:', {
                            newLines: newLines.length,
                            startLine,
                            endLine,
                            oldScrollTop,
                            lineHeightPx
                        });
                        
                        // 渲染新内容
                        renderVirtualContent(newLines, startLine, endLine);
                        
                        console.log('After renderVirtualContent:', {
                            container: scrollContainer ? scrollContainer.children.length : 0,
                            scrollTop: scrollContainer ? scrollContainer.scrollTop : 0
                        });
                        
                        if (isJump) {
                            // 跳转操作：直接滚动到目标行（不检查范围，因为已经加载了）
                            // 使用 requestAnimationFrame 确保 DOM 已更新
                            requestAnimationFrame(() => {
                                // 确保 lineHeightPx 已初始化（从已渲染的行中获取）
                                if (lineHeightPx === 0) {
                                    const testLine = document.querySelector('.content-line');
                                    if (testLine) {
                                        lineHeightPx = testLine.offsetHeight || (fontSize * lineHeight);
                                    } else {
                                        // 如果还没有行元素，使用配置值计算
                                        lineHeightPx = fontSize * lineHeight;
                                    }
                                }
                                
                                // 直接计算并设置滚动位置
                                if (lineHeightPx > 0 && scrollContainer) {
                                    const scrollTop = targetLine * lineHeightPx;
                                    scrollContainer.scrollTop = scrollTop;
                                    currentLine = targetLine;
                                    updateProgressInfo(targetLine);
                                    
                                    // 再次确保滚动位置正确（有时需要两次）
                                    requestAnimationFrame(() => {
                                        if (scrollContainer && lineHeightPx > 0) {
                                            scrollContainer.scrollTop = targetLine * lineHeightPx;
                                        }
                                    });
                                }
                            });
                        } else {
                            // 滚动触发的加载：恢复滚动位置
                            // 使用 requestAnimationFrame 确保 DOM 已更新
                            requestAnimationFrame(() => {
                                if (scrollContainer && lineHeightPx > 0) {
                                    // 恢复滚动位置
                                    scrollContainer.scrollTop = oldScrollTop;
                                    
                                    // 再次确保（有时需要两次）
                                    requestAnimationFrame(() => {
                                        if (scrollContainer && lineHeightPx > 0) {
                                            scrollContainer.scrollTop = oldScrollTop;
                                            
                                            // 验证内容是否正确显示
                                            const visibleLines = document.querySelectorAll('.content-line');
                                            console.log('After restore scroll:', {
                                                scrollTop: scrollContainer.scrollTop,
                                                oldScrollTop,
                                                visibleLines: visibleLines.length,
                                                startLine,
                                                endLine
                                            });
                                        }
                                    });
                                }
                            });
                            
                            // 如果是初始加载，滚动到保存的位置
                            if (isInitialLoad && currentLine >= startLine && currentLine <= endLine) {
                                setTimeout(() => {
                                    scrollToLine(currentLine);
                                }, 50);
                            }
                        }
                    }
                    break;
                    
                case 'updateScroll':
                    scrollToLine(message.currentLine);
                    break;
                    
                case 'updateChapters':
                    displayChapters(message.chapters);
                    break;
                    
                case 'chapterScanProgress':
                    // 章节扫描进度
                    const progressEl = document.getElementById('chapters-list');
                    if (progressEl) {
                        const percent = Math.round((message.progress / message.total) * 100);
                        progressEl.innerHTML = \`<div class="loading-indicator">正在扫描章节... \${percent}%</div>\`;
                    }
                    break;
                    
                case 'chapterScanComplete':
                    displayChapters(message.chapters);
                    break;
                    
                case 'searchResults':
                    displaySearchResults(message.results, message.searchTerm, message.hasMore, message.progress, message.total);
                    break;
            }
        });
        
        function displayChapters(chapters) {
            allChapters = chapters;
            const container = document.getElementById('chapters-list');
            
            if (chapters.length === 0) {
                container.innerHTML = '<div class="empty-message">未识别到章节<br>请配置章节分割规则</div>';
                return;
            }
            
            container.innerHTML = chapters.map(chapter => 
                \`<div class="chapter-item" onclick="jumpToChapter(\${chapter.line})">
                    <div class="chapter-name">\${escapeHtml(chapter.name)}</div>
                    <div class="chapter-line">第 \${chapter.line} 行</div>
                </div>\`
            ).join('');
            
            // 更新当前章节高亮，只在初次加载时自动滚动
            updateCurrentChapter(currentLine, isInitialLoad);
            if (isInitialLoad) {
                isInitialLoad = false; // 首次加载后设为 false
            }
        }
        
        function displaySearchResults(results, searchTerm, hasMore, progress, total) {
            const container = document.getElementById('search-results');
            
            if (results.length === 0 && (!progress || progress === 0)) {
                container.innerHTML = '<div class="empty-message">未找到匹配结果</div>';
                return;
            }
            
            let html = '';
            
            // 显示搜索进度
            if (progress !== undefined && total !== undefined) {
                const percent = Math.round((progress / total) * 100);
                html += \`<div class="loading-indicator">正在搜索... \${percent}%</div>\`;
            }
            
            // 显示结果
            if (results.length > 0) {
                html += results.map(result => {
                    const content = escapeHtml(result.content);
                    const highlightedContent = content.replace(
                        new RegExp(escapeHtml(searchTerm), 'g'),
                        \`<span class="search-highlight">\${escapeHtml(searchTerm)}</span>\`
                    );
                    
                    return \`<div class="search-result-item" onclick="jumpToChapter(\${result.line})">
                        <div class="search-line">第 \${result.line} 行</div>
                        <div class="search-content">\${highlightedContent}</div>
                    </div>\`;
                }).join('');
                
                if (hasMore) {
                    html += '<div class="empty-message">结果较多，已限制显示数量</div>';
                }
            }
            
            container.innerHTML = html;
        }
        
        function jumpToChapter(line) {
            console.log('jumpToChapter called with line:', line);
            vscode.postMessage({ command: 'jumpToLine', line: line });
        }
        
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        // 初始化 toggle 按钮位置（页面加载时侧边栏是显示的）
        const initToggle = document.getElementById('sidebar-toggle');
        if (initToggle) {
            initToggle.classList.add('sidebar-visible');
        }
        
        // 请求初始数据
        vscode.postMessage({ command: 'requestInitialContent' });
        vscode.postMessage({ command: 'requestChapters' });
    </script>
</body>
</html>`;
  }
}
