import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BookConfig, BookConfigManager } from './bookConfig';

interface Chapter {
    name: string;
    line: number;
}

interface SearchResult {
    line: number;
    content: string;
}

export class TxtReaderProvider {
    private panel: vscode.WebviewPanel | undefined;
    private content: string = '';
    private lines: string[] = [];
    private currentLine: number = 0;
    private chapters: Chapter[] = [];
    private fileUri: vscode.Uri;
    private extensionUri: vscode.Uri;
    private bookConfig: BookConfig | null = null;
    private saveProgressTimer: NodeJS.Timeout | undefined;

    constructor(extensionUri: vscode.Uri, fileUri: vscode.Uri) {
        this.extensionUri = extensionUri;
        this.fileUri = fileUri;
    }

    public async show(context: vscode.ExtensionContext) {
        // 读取文档内容
        await this.loadFile();

        // 加载文档配置
        this.bookConfig = await BookConfigManager.loadConfig(this.fileUri.fsPath);
        if (this.bookConfig) {
            this.currentLine = this.bookConfig.progress;
        }

        // 创建并显示 webview
        this.panel = vscode.window.createWebviewPanel(
            'omTxtReader',
            path.basename(this.fileUri.fsPath),
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        // 设置 context
        vscode.commands.executeCommand('setContext', 'omTxtReaderActive', true);

        // 扫描章节
        this.scanChapters();

        // 设置 webview 内容
        this.panel.webview.html = this.getWebviewContent();

        // 处理来自 webview 的消息
        this.panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'scrollUp':
                        this.scrollUp();
                        break;
                    case 'scrollDown':
                        this.scrollDown();
                        break;
                    case 'jumpToLine':
                        this.jumpToLine(message.line);
                        break;
                    case 'search':
                        this.search(message.text);
                        break;
                    case 'jumpToChapter':
                        this.jumpToLine(message.line);
                        break;
                    case 'requestChapters':
                        this.sendChaptersToWebview();
                        break;
                    case 'updateProgress':
                        this.updateProgress(message.line);
                        break;
                    case 'requestInitialContent':
                        this.sendInitialContent();
                        break;
                }
            },
            undefined,
            context.subscriptions
        );

        // 监听 panel 关闭事件
        this.panel.onDidDispose(() => {
            vscode.commands.executeCommand('setContext', 'omTxtReaderActive', false);
            this.saveProgressNow();
            if (this.saveProgressTimer) {
                clearTimeout(this.saveProgressTimer);
            }
            this.panel = undefined;
        });

        // 发送初始数据
        this.sendInitialContent();
    }

    private async loadFile() {
        try {
            const buffer = await vscode.workspace.fs.readFile(this.fileUri);
            this.content = this.decodeBuffer(buffer);
            this.lines = this.content.split('\n');
        } catch (error) {
            vscode.window.showErrorMessage(`无法读取文档: ${error}`);
        }
    }

    private decodeBuffer(buffer: Uint8Array): string {
        // 尝试 UTF-8
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        } catch {
            // 如果 UTF-8 失败，尝试 GBK
            try {
                return new TextDecoder('gbk').decode(buffer);
            } catch {
                // 如果都失败，使用默认解码
                return new TextDecoder().decode(buffer);
            }
        }
    }

    private scanChapters() {
        this.chapters = [];
        const config = vscode.workspace.getConfiguration('omTxtReader');
        
        // 优先使用文档特定的规则，否则使用全局默认规则
        let patternStr = this.bookConfig?.chapterPattern;
        if (!patternStr) {
            patternStr = config.get<string>('defaultChapterPattern', '^第[0-9一二三四五六七八九十百千]+[章节]\\s+.+$');
        }
        
        try {
            const pattern = new RegExp(patternStr);
            
            for (let i = 0; i < this.lines.length; i++) {
                const line = this.lines[i].trim();
                if (pattern.test(line)) {
                    this.chapters.push({
                        name: line,
                        line: i
                    });
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`章节分割规则错误: ${error}`);
        }
    }

    public reloadChapters() {
        this.scanChapters();
        this.sendChaptersToWebview();
        vscode.window.showInformationMessage(`已识别 ${this.chapters.length} 个章节`);
    }

    public scrollUp() {
        const config = vscode.workspace.getConfiguration('omTxtReader');
        const step = config.get<number>('scrollStep', 3);
        this.currentLine = Math.max(0, this.currentLine - step);
        this.updateWebview();
    }

    public scrollDown() {
        const config = vscode.workspace.getConfiguration('omTxtReader');
        const step = config.get<number>('scrollStep', 3);
        this.currentLine = Math.min(this.lines.length - 1, this.currentLine + step);
        this.updateWebview();
    }

    public jumpToLine(line: number) {
        if (line >= 0 && line < this.lines.length) {
            this.currentLine = line;
            this.updateWebview();
        }
    }

    public search(searchTerm: string) {
        const results: SearchResult[] = [];
        
        for (let i = 0; i < this.lines.length; i++) {
            if (this.lines[i].includes(searchTerm)) {
                results.push({
                    line: i,
                    content: this.lines[i].trim()
                });
            }
        }

        if (this.panel) {
            this.panel.webview.postMessage({
                command: 'searchResults',
                results: results,
                searchTerm: searchTerm
            });
        }

        if (results.length === 0) {
            vscode.window.showInformationMessage(`未找到 "${searchTerm}"`);
        } else {
            vscode.window.showInformationMessage(`找到 ${results.length} 个匹配结果`);
        }
    }

    public showChapters() {
        if (this.chapters.length === 0) {
            vscode.window.showInformationMessage('未识别到任何章节，请配置章节分割规则');
            return;
        }

        this.sendChaptersToWebview();
    }

    private sendChaptersToWebview() {
        if (this.panel) {
            this.panel.webview.postMessage({
                command: 'updateChapters',
                chapters: this.chapters
            });
        }
    }

    private sendInitialContent() {
        if (this.panel) {
            this.panel.webview.postMessage({
                command: 'initContent',
                allLines: this.lines,
                currentLine: this.currentLine,
                totalLines: this.lines.length
            });
            this.sendChaptersToWebview();
        }
    }

    private updateWebview() {
        if (this.panel) {
            this.panel.webview.postMessage({
                command: 'updateScroll',
                currentLine: this.currentLine
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
            await BookConfigManager.updateProgress(
                this.fileUri.fsPath,
                this.currentLine,
                this.lines.length
            );
        }
    }

    private getWebviewContent(): string {
        const config = vscode.workspace.getConfiguration('omTxtReader');
        const fontSize = config.get<number>('fontSize', 16);
        const lineHeight = config.get<number>('lineHeight', 1.8);

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OM-TXT-Reader</title>
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
        }
        
        .content-line {
            min-height: 1em;
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
        
        // 监听滚动事件，更新当前行
        const contentArea = document.getElementById('content');
        let scrollTimeout;
        contentArea.addEventListener('scroll', () => {
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                // 找到当前可见的第一个元素
                const lines = document.querySelectorAll('.content-line');
                const containerRect = contentArea.getBoundingClientRect();
                
                for (let i = 0; i < lines.length; i++) {
                    const lineRect = lines[i].getBoundingClientRect();
                    // 如果元素的底部在容器内
                    if (lineRect.bottom > containerRect.top + 50) {
                        const lineNum = parseInt(lines[i].getAttribute('data-line'));
                        updateProgressInfo(lineNum);
                        vscode.postMessage({ command: 'updateProgress', line: lineNum });
                        break;
                    }
                }
            }, 100);
        });
        
        function updateProgressInfo(line) {
            currentLine = line;
            document.getElementById('current-line').textContent = line;
            const percent = totalLines > 0 ? Math.round((line / totalLines) * 100) : 0;
            document.getElementById('progress-percent').textContent = percent;
            
            // 更新当前章节显示和高亮
            updateCurrentChapter(line, false); // 滚动时不自动定位
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
            const lineElement = document.querySelector(\`.content-line[data-line="\${lineNum}"]\`);
            if (lineElement) {
                lineElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
                updateProgressInfo(lineNum);
            }
        }
        
        // 监听来自扩展的消息
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
                case 'initContent':
                    allLines = message.allLines;
                    totalLines = message.totalLines;
                    currentLine = message.currentLine;
                    
                    // 渲染内容，每行添加 data-line 属性
                    document.getElementById('content').innerHTML = 
                        allLines.map((line, index) => 
                            \`<div class="content-line" data-line="\${index}">\${escapeHtml(line) || '&nbsp;'}</div>\`
                        ).join('');
                    document.getElementById('total-lines').textContent = totalLines;
                    
                    // 滚动到保存的位置
                    setTimeout(() => {
                        scrollToLine(currentLine);
                    }, 100);
                    break;
                    
                case 'updateScroll':
                    scrollToLine(message.currentLine);
                    break;
                    
                case 'updateChapters':
                    displayChapters(message.chapters);
                    break;
                    
                case 'searchResults':
                    displaySearchResults(message.results, message.searchTerm);
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
        
        function displaySearchResults(results, searchTerm) {
            const container = document.getElementById('search-results');
            
            if (results.length === 0) {
                container.innerHTML = '<div class="empty-message">未找到匹配结果</div>';
                return;
            }
            
            container.innerHTML = results.map(result => {
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
        }
        
        function jumpToChapter(line) {
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
