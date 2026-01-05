import * as vscode from 'vscode';
import { BookConfig, BookConfigManager } from './bookConfig';

export class BookshelfProvider {
    private panel: vscode.WebviewPanel | undefined;
    private extensionUri: vscode.Uri;

    constructor(extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;
    }

    public async show(context: vscode.ExtensionContext) {
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'evaReaderBookshelf',
            'EVA Reader',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.panel.webview.html = await this.getWebviewContent();

        this.panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'openBook':
                        await vscode.commands.executeCommand('evaReader.openBook', vscode.Uri.file(message.filePath));
                        break;
                    case 'configureBook':
                        await this.configureBookPattern(message.filePath);
                        break;
                    case 'refresh':
                        await this.refresh();
                        break;
                    case 'selectDirectory':
                        await this.selectDirectory();
                        break;
                    case 'openSettings':
                        await vscode.commands.executeCommand('evaReader.openSettings');
                        break;
                }
            },
            undefined,
            context.subscriptions
        );

        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });

        await this.refresh();
    }

    private async refresh() {
        const config = vscode.workspace.getConfiguration('evaReader');
        const booksDir = config.get<string>('booksDirectory', '');

        if (!booksDir) {
            this.sendMessage({
                command: 'updateBooks',
                books: [],
                hasDirectory: false
            });
            return;
        }

        const books = await BookConfigManager.getAllBooksInDirectory(booksDir);
        
        this.sendMessage({
            command: 'updateBooks',
            books: books,
            hasDirectory: true,
            directory: booksDir
        });
    }

    private async selectDirectory() {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: '选择文档目录'
        });

        if (result && result.length > 0) {
            const config = vscode.workspace.getConfiguration('evaReader');
            await config.update('booksDirectory', result[0].fsPath, vscode.ConfigurationTarget.Global);
            await this.refresh();
        }
    }

    private async configureBookPattern(filePath: string) {
        const config = await BookConfigManager.loadConfig(filePath);
        const globalConfig = vscode.workspace.getConfiguration('evaReader');
        const defaultPattern = globalConfig.get<string>('defaultChapterPattern', '');
        
        const currentPattern = config?.chapterPattern || defaultPattern;

        const newPattern = await vscode.window.showInputBox({
            prompt: '请输入该文档的章节分割规则（正则表达式）',
            value: currentPattern,
            placeHolder: '^第[0-9一二三四五六七八九十百千]+[章节]\\s+.+$'
        });

        if (newPattern !== undefined) {
            await BookConfigManager.updateChapterPattern(filePath, newPattern);
            vscode.window.showInformationMessage('章节分割规则已更新');
            await this.refresh();
        }
    }

    private sendMessage(message: any) {
        if (this.panel) {
            this.panel.webview.postMessage(message);
        }
    }

    private async getWebviewContent(): Promise<string> {
        const config = vscode.workspace.getConfiguration('evaReader');
        const fontSize = config.get<number>('fontSize', 16);

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
            padding: 20px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 2px solid var(--vscode-panel-border);
        }
        
        .header h1 {
            font-size: 24px;
            font-weight: 600;
        }
        
        .header-buttons {
            display: flex;
            gap: 10px;
        }
        
        .btn {
            padding: 8px 16px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 13px;
            transition: background-color 0.2s;
        }
        
        .btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .btn-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: var(--vscode-descriptionForeground);
        }
        
        .empty-state-icon {
            font-size: 64px;
            margin-bottom: 20px;
            opacity: 0.5;
        }
        
        .empty-state h2 {
            font-size: 20px;
            margin-bottom: 10px;
        }
        
        .empty-state p {
            margin-bottom: 20px;
            font-size: 14px;
        }
        
        .books-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 15px;
        }
        
        .book-card {
            background-color: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 16px;
            transition: all 0.2s;
            cursor: pointer;
        }
        
        .book-card:hover {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }
        
        .book-header {
            display: flex;
            justify-content: space-between;
            align-items: start;
            margin-bottom: 12px;
        }
        
        .book-title {
            font-size: 16px;
            font-weight: 600;
            flex: 1;
            word-break: break-word;
        }
        
        .book-config-btn {
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            font-size: 18px;
            padding: 0 5px;
            transition: color 0.2s;
        }
        
        .book-config-btn:hover {
            color: var(--vscode-textLink-foreground);
        }
        
        .book-info {
            display: flex;
            flex-direction: column;
            gap: 6px;
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }
        
        .book-info-row {
            display: flex;
            justify-content: space-between;
        }
        
        .progress-bar {
            width: 100%;
            height: 6px;
            background-color: var(--vscode-progressBar-background);
            border-radius: 3px;
            margin-top: 10px;
            overflow: hidden;
        }
        
        .progress-fill {
            height: 100%;
            background-color: var(--vscode-progressBar-background);
            transition: width 0.3s;
        }
        
        .book-stats {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
        
        .directory-info {
            background-color: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 12px;
            margin-bottom: 20px;
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }
        
        .directory-info strong {
            color: var(--vscode-editor-foreground);
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>📚 EVA Reader</h1>
        <div class="header-buttons">
            <button class="btn btn-secondary" onclick="refresh()">刷新</button>
            <button class="btn" onclick="openSettings()">配置</button>
        </div>
    </div>
    
    <div id="directory-info" style="display: none;" class="directory-info"></div>
    
    <div id="empty-state" class="empty-state">
        <div class="empty-state-icon">📖</div>
        <h2>还没有设置文档目录</h2>
        <p>请先选择一个包含文档的目录</p>
        <button class="btn" onclick="selectDirectory()">选择目录</button>
    </div>
    
    <div id="books-grid" class="books-grid" style="display: none;"></div>

    <script>
        const vscode = acquireVsCodeApi();
        
        function openBook(filePath) {
            vscode.postMessage({ command: 'openBook', filePath: filePath });
        }
        
        function configureBook(event, filePath) {
            event.stopPropagation();
            vscode.postMessage({ command: 'configureBook', filePath: filePath });
        }
        
        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }
        
        function selectDirectory() {
            vscode.postMessage({ command: 'selectDirectory' });
        }
        
        function openSettings() {
            vscode.postMessage({ command: 'openSettings' });
        }
        
        function formatFileSize(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
        }
        
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'updateBooks') {
                const emptyState = document.getElementById('empty-state');
                const booksGrid = document.getElementById('books-grid');
                const directoryInfo = document.getElementById('directory-info');
                
                if (!message.hasDirectory || message.books.length === 0) {
                    emptyState.style.display = 'block';
                    booksGrid.style.display = 'none';
                    directoryInfo.style.display = 'none';
                    
                    if (message.hasDirectory) {
                        emptyState.innerHTML = \`
                            <div class="empty-state-icon">📂</div>
                            <h2>目录中没有找到文档</h2>
                            <p>当前目录：\${escapeHtml(message.directory)}</p>
                            <button class="btn" onclick="selectDirectory()">重新选择目录</button>
                        \`;
                    }
                } else {
                    emptyState.style.display = 'none';
                    booksGrid.style.display = 'grid';
                    directoryInfo.style.display = 'block';
                    directoryInfo.innerHTML = \`<strong>文档目录：</strong> \${escapeHtml(message.directory)}\`;
                    
                    booksGrid.innerHTML = message.books.map(book => {
                        const progress = book.totalLines > 0 
                            ? Math.round((book.progress / book.totalLines) * 100) 
                            : 0;
                        const lastRead = formatLastReadTime(book.lastReadTime);
                        
                        return \`
                            <div class="book-card" onclick="openBook('\${book.filePath.replace(/\\\\/g, '\\\\\\\\')}')">
                                <div class="book-header">
                                    <div class="book-title">\${escapeHtml(book.fileName)}</div>
                                    <button class="book-config-btn" onclick="configureBook(event, '\${book.filePath.replace(/\\\\/g, '\\\\\\\\')}')">⚙️</button>
                                </div>
                                <div class="book-info">
                                    <div class="book-info-row">
                                        <span>总行数：\${book.totalLines.toLocaleString()}</span>
                                        <span>进度：\${progress}%</span>
                                    </div>
                                    <div class="book-info-row">
                                        <span>上次阅读：\${lastRead}</span>
                                    </div>
                                </div>
                                <div class="progress-bar">
                                    <div class="progress-fill" style="width: \${progress}%"></div>
                                </div>
                            </div>
                        \`;
                    }).join('');
                }
            }
        });
        
        function formatLastReadTime(isoString) {
            const date = new Date(isoString);
            const now = new Date();
            const diffMs = now.getTime() - date.getTime();
            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMs / 3600000);
            const diffDays = Math.floor(diffMs / 86400000);

            if (diffMins < 1) {
                return '刚刚';
            } else if (diffMins < 60) {
                return diffMins + '分钟前';
            } else if (diffHours < 24) {
                return diffHours + '小时前';
            } else if (diffDays < 7) {
                return diffDays + '天前';
            } else {
                return date.toLocaleDateString('zh-CN');
            }
        }
        
        // 请求初始数据
        refresh();
    </script>
</body>
</html>`;
    }
}

