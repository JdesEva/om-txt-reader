import * as vscode from "vscode";

export class SettingsProvider {
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
      "evaReaderSettings",
      "EVA Reader 配置",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.panel.webview.html = this.getWebviewContent();

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case "selectDirectory":
            await this.selectDirectory();
            break;
          case "saveSettings":
            await this.saveSettings(message.settings);
            break;
          case "requestSettings":
            await this.sendCurrentSettings();
            break;
        }
      },
      undefined,
      context.subscriptions
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    await this.sendCurrentSettings();
  }

  private async selectDirectory() {
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: "选择文档目录",
    });

    if (result && result.length > 0) {
      this.sendMessage({
        command: "updateDirectory",
        directory: result[0].fsPath,
      });
    }
  }

  private async saveSettings(settings: any) {
    const config = vscode.workspace.getConfiguration("evaReader");

    try {
      await config.update(
        "booksDirectory",
        settings.booksDirectory,
        vscode.ConfigurationTarget.Global
      );
      await config.update(
        "defaultChapterPattern",
        settings.defaultChapterPattern,
        vscode.ConfigurationTarget.Global
      );
      await config.update(
        "fontSize",
        settings.fontSize,
        vscode.ConfigurationTarget.Global
      );
      await config.update(
        "lineHeight",
        settings.lineHeight,
        vscode.ConfigurationTarget.Global
      );
      await config.update(
        "scrollStep",
        settings.scrollStep,
        vscode.ConfigurationTarget.Global
      );
      await config.update(
        "largeFileThreshold",
        settings.largeFileThreshold,
        vscode.ConfigurationTarget.Global
      );
      await config.update(
        "chunkSize",
        settings.chunkSize,
        vscode.ConfigurationTarget.Global
      );
      await config.update(
        "bufferLines",
        settings.bufferLines,
        vscode.ConfigurationTarget.Global
      );
      await config.update(
        "enableVirtualScroll",
        settings.enableVirtualScroll,
        vscode.ConfigurationTarget.Global
      );

      vscode.window.showInformationMessage("配置已保存");
      await this.sendCurrentSettings();
    } catch (error) {
      vscode.window.showErrorMessage(`保存配置失败: ${error}`);
    }
  }

  private async sendCurrentSettings() {
    const config = vscode.workspace.getConfiguration("evaReader");

    this.sendMessage({
      command: "updateSettings",
      settings: {
        booksDirectory: config.get<string>("booksDirectory", ""),
        defaultChapterPattern: config.get<string>(
          "defaultChapterPattern",
          "^第[0-9一二三四五六七八九十百千]+[章节]\\s+.+$"
        ),
        fontSize: config.get<number>("fontSize", 16),
        lineHeight: config.get<number>("lineHeight", 1.8),
        scrollStep: config.get<number>("scrollStep", 3),
        largeFileThreshold: config.get<number>("largeFileThreshold", 5),
        chunkSize: config.get<number>("chunkSize", 200),
        bufferLines: config.get<number>("bufferLines", 50),
        enableVirtualScroll: config.get<boolean>("enableVirtualScroll", true),
      },
    });
  }

  private sendMessage(message: any) {
    if (this.panel) {
      this.panel.webview.postMessage(message);
    }
  }

  private getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>EVA Reader 配置</title>
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
            max-width: 800px;
            margin: 0 auto;
        }
        
        .header {
            margin-bottom: 30px;
            padding-bottom: 15px;
            border-bottom: 2px solid var(--vscode-panel-border);
        }
        
        .header h1 {
            font-size: 24px;
            font-weight: 600;
        }
        
        .section {
            margin-bottom: 30px;
        }
        
        .section-title {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 15px;
            color: var(--vscode-textLink-foreground);
        }
        
        .form-group {
            margin-bottom: 20px;
        }
        
        .form-label {
            display: block;
            margin-bottom: 8px;
            font-size: 14px;
            font-weight: 500;
        }
        
        .form-description {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
        
        .form-input {
            width: 100%;
            padding: 8px 12px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            font-size: 13px;
            font-family: inherit;
        }
        
        .form-input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        
        .directory-input-group {
            display: flex;
            gap: 10px;
        }
        
        .directory-input-group .form-input {
            flex: 1;
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
        
        .btn-large {
            padding: 10px 20px;
            font-size: 14px;
            font-weight: 500;
        }
        
        .button-group {
            display: flex;
            gap: 10px;
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        
        .examples {
            background-color: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 15px;
            margin-top: 15px;
        }
        
        .examples-title {
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 10px;
        }
        
        .example-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px;
            margin-bottom: 8px;
            background-color: var(--vscode-editor-background);
            border-radius: 3px;
            font-size: 12px;
        }
        
        .example-pattern {
            font-family: 'Courier New', monospace;
            color: var(--vscode-textPreformat-foreground);
            flex: 1;
            margin-right: 10px;
        }
        
        .example-desc {
            color: var(--vscode-descriptionForeground);
            margin-right: 10px;
        }
        
        .example-use-btn {
            padding: 4px 10px;
            font-size: 11px;
        }
        
        .number-input {
            width: 100px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>⚙️ EVA Reader 配置</h1>
    </div>
    
    <form id="settings-form">
        <div class="section">
            <div class="section-title">📁 文档目录</div>
            <div class="form-group">
                <label class="form-label">文档目录</label>
                <div class="directory-input-group">
                    <input type="text" id="booksDirectory" class="form-input" placeholder="选择包含文档的目录" readonly>
                    <button type="button" class="btn" onclick="selectDirectory()">浏览</button>
                </div>
                <div class="form-description">设置书架中显示的文档所在目录</div>
            </div>
        </div>
        
        <div class="section">
            <div class="section-title">📖 章节分割</div>
            <div class="form-group">
                <label class="form-label">默认章节分割规则（正则表达式）</label>
                <input type="text" id="defaultChapterPattern" class="form-input" placeholder="^第[0-9]+章.+$">
                <div class="form-description">此规则将应用于所有未单独配置的文档</div>
            </div>
            
            <div class="examples">
                <div class="examples-title">常用章节分割规则</div>
                <div class="example-item">
                    <span class="example-pattern">^第[0-9一二三四五六七八九十百千]+[章节]\\s+.+$</span>
                    <span class="example-desc">第一章 标题</span>
                    <button type="button" class="btn btn-secondary example-use-btn" onclick="usePattern('^第[0-9一二三四五六七八九十百千]+[章节]\\\\s+.+$')">使用</button>
                </div>
                <div class="example-item">
                    <span class="example-pattern">^[0-9]+、.+$</span>
                    <span class="example-desc">1、标题</span>
                    <button type="button" class="btn btn-secondary example-use-btn" onclick="usePattern('^[0-9]+、.+$')">使用</button>
                </div>
                <div class="example-item">
                    <span class="example-pattern">^[0-9]+\\s+.+$</span>
                    <span class="example-desc">1 标题</span>
                    <button type="button" class="btn btn-secondary example-use-btn" onclick="usePattern('^[0-9]+\\\\s+.+$')">使用</button>
                </div>
                <div class="example-item">
                    <span class="example-pattern">^[0-9]+\\.\\s+.+$</span>
                    <span class="example-desc">1. 标题</span>
                    <button type="button" class="btn btn-secondary example-use-btn" onclick="usePattern('^[0-9]+\\\\.\\\\s+.+$')">使用</button>
                </div>
                <div class="example-item">
                    <span class="example-pattern">^Chapter\\s+[0-9]+</span>
                    <span class="example-desc">Chapter 1</span>
                    <button type="button" class="btn btn-secondary example-use-btn" onclick="usePattern('^Chapter\\\\s+[0-9]+')">使用</button>
                </div>
                <div class="example-item">
                    <span class="example-pattern">.*章.*</span>
                    <span class="example-desc">包含"章"字</span>
                    <button type="button" class="btn btn-secondary example-use-btn" onclick="usePattern('.*章.*')">使用</button>
                </div>
            </div>
        </div>
        
        <div class="section">
            <div class="section-title">🎨 阅读器样式</div>
            <div class="form-group">
                <label class="form-label">字体大小（像素）</label>
                <input type="number" id="fontSize" class="form-input number-input" min="12" max="32" step="1">
                <div class="form-description">阅读器中文本的字体大小</div>
            </div>
            <div class="form-group">
                <label class="form-label">行高</label>
                <input type="number" id="lineHeight" class="form-input number-input" min="1.0" max="3.0" step="0.1">
                <div class="form-description">文本行与行之间的间距（1.0 - 3.0）</div>
            </div>
            <div class="form-group">
                <label class="form-label">滚动步进（行）</label>
                <input type="number" id="scrollStep" class="form-input number-input" min="1" max="10" step="1">
                <div class="form-description">每次滚动移动的行数</div>
            </div>
        </div>
        
        <div class="section">
            <div class="section-title">⚡ 性能优化</div>
            <div class="form-group">
                <label class="form-label">大文件阈值（MB）</label>
                <input type="number" id="largeFileThreshold" class="form-input number-input" min="1" max="100" step="1">
                <div class="form-description">超过此大小的文件将启用分块加载和虚拟滚动</div>
            </div>
            <div class="form-group">
                <label class="form-label">分块大小（行）</label>
                <input type="number" id="chunkSize" class="form-input number-input" min="50" max="1000" step="50">
                <div class="form-description">分块加载时每块的行数</div>
            </div>
            <div class="form-group">
                <label class="form-label">缓冲区行数</label>
                <input type="number" id="bufferLines" class="form-input number-input" min="20" max="200" step="10">
                <div class="form-description">虚拟滚动时上下各缓冲的行数</div>
            </div>
            <div class="form-group">
                <label class="form-label">启用虚拟滚动</label>
                <input type="checkbox" id="enableVirtualScroll" style="width: auto; margin-right: 8px;">
                <span style="font-size: 13px; color: var(--vscode-descriptionForeground);">大文件时建议启用，可显著提升性能</span>
            </div>
        </div>
        
        <div class="button-group">
            <button type="submit" class="btn btn-large">保存配置</button>
            <button type="button" class="btn btn-secondary btn-large" onclick="cancel()">取消</button>
        </div>
    </form>

    <script>
        const vscode = acquireVsCodeApi();
        
        function selectDirectory() {
            vscode.postMessage({ command: 'selectDirectory' });
        }
        
        function usePattern(pattern) {
            document.getElementById('defaultChapterPattern').value = pattern;
        }
        
        function cancel() {
            // 可以关闭面板或返回书架
        }
        
        document.getElementById('settings-form').addEventListener('submit', (e) => {
            e.preventDefault();
            
            const settings = {
                booksDirectory: document.getElementById('booksDirectory').value,
                defaultChapterPattern: document.getElementById('defaultChapterPattern').value,
                fontSize: parseInt(document.getElementById('fontSize').value),
                lineHeight: parseFloat(document.getElementById('lineHeight').value),
                scrollStep: parseInt(document.getElementById('scrollStep').value),
                largeFileThreshold: parseInt(document.getElementById('largeFileThreshold').value),
                chunkSize: parseInt(document.getElementById('chunkSize').value),
                bufferLines: parseInt(document.getElementById('bufferLines').value),
                enableVirtualScroll: document.getElementById('enableVirtualScroll').checked
            };
            
            vscode.postMessage({ command: 'saveSettings', settings: settings });
        });
        
        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'updateSettings') {
                const settings = message.settings;
                document.getElementById('booksDirectory').value = settings.booksDirectory;
                document.getElementById('defaultChapterPattern').value = settings.defaultChapterPattern;
                document.getElementById('fontSize').value = settings.fontSize;
                document.getElementById('lineHeight').value = settings.lineHeight;
                document.getElementById('scrollStep').value = settings.scrollStep;
                document.getElementById('largeFileThreshold').value = settings.largeFileThreshold;
                document.getElementById('chunkSize').value = settings.chunkSize;
                document.getElementById('bufferLines').value = settings.bufferLines;
                document.getElementById('enableVirtualScroll').checked = settings.enableVirtualScroll;
            } else if (message.command === 'updateDirectory') {
                document.getElementById('booksDirectory').value = message.directory;
            }
        });
        
        // 请求当前设置
        vscode.postMessage({ command: 'requestSettings' });
    </script>
</body>
</html>`;
  }
}
