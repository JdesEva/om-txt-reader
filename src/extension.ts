import * as vscode from 'vscode';
import { TxtReaderProvider } from './readerProvider';
import { BookshelfProvider } from './bookshelfProvider';
import { SettingsProvider } from './settingsProvider';
import { BookConfigManager } from './bookConfig';

let readerProvider: TxtReaderProvider | undefined;
let bookshelfProvider: BookshelfProvider | undefined;
let settingsProvider: SettingsProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('OM-TXT-Reader 插件已激活');

    bookshelfProvider = new BookshelfProvider(context.extensionUri);
    settingsProvider = new SettingsProvider(context.extensionUri);

    // 注册命令：打开书架
    const openBookshelfCommand = vscode.commands.registerCommand('omTxtReader.openBookshelf', async () => {
        await bookshelfProvider!.show(context);
    });

    // 注册命令：打开配置
    const openSettingsCommand = vscode.commands.registerCommand('omTxtReader.openSettings', async () => {
        await settingsProvider!.show(context);
    });

    // 注册命令：打开文档
    const openBookCommand = vscode.commands.registerCommand('omTxtReader.openBook', async (uri?: vscode.Uri) => {
        let fileUri = uri;
        
        if (!fileUri) {
            // 如果没有传入 URI，尝试获取当前活动编辑器的文档
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                fileUri = activeEditor.document.uri;
            } else {
                // 让用户选择文档
                const files = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: {
                        'Text files': ['txt']
                    }
                });
                
                if (files && files.length > 0) {
                    fileUri = files[0];
                }
            }
        }

        if (fileUri) {
            readerProvider = new TxtReaderProvider(context.extensionUri, fileUri);
            await readerProvider.show(context);
        } else {
            vscode.window.showErrorMessage('请选择一个文档');
        }
    });

    // 注册命令：向下滚动
    const scrollDownCommand = vscode.commands.registerCommand('omTxtReader.scrollDown', () => {
        if (readerProvider) {
            readerProvider.scrollDown();
        }
    });

    // 注册命令：向上滚动
    const scrollUpCommand = vscode.commands.registerCommand('omTxtReader.scrollUp', () => {
        if (readerProvider) {
            readerProvider.scrollUp();
        }
    });

    // 注册命令：搜索
    const searchCommand = vscode.commands.registerCommand('omTxtReader.search', async () => {
        if (readerProvider) {
            const searchTerm = await vscode.window.showInputBox({
                prompt: '请输入要搜索的文本'
            });

            if (searchTerm) {
                readerProvider.search(searchTerm);
            }
        }
    });

    // 注册命令：显示章节列表
    const showChaptersCommand = vscode.commands.registerCommand('omTxtReader.showChapters', () => {
        if (readerProvider) {
            readerProvider.showChapters();
        }
    });

    // 注册命令：配置当前文档的章节分割规则
    const configureBookPatternCommand = vscode.commands.registerCommand('omTxtReader.configureBookPattern', async () => {
        if (!readerProvider) {
            vscode.window.showWarningMessage('请先打开文档');
            return;
        }

        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            vscode.window.showWarningMessage('无法获取当前文档');
            return;
        }

        const filePath = activeEditor.document.uri.fsPath;
        const config = await BookConfigManager.loadConfig(filePath);
        const globalConfig = vscode.workspace.getConfiguration('omTxtReader');
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
            
            // 重新扫描章节
            if (readerProvider) {
                readerProvider.reloadChapters();
            }
        }
    });

    context.subscriptions.push(
        openBookshelfCommand,
        openSettingsCommand,
        openBookCommand,
        scrollDownCommand,
        scrollUpCommand,
        searchCommand,
        showChaptersCommand,
        configureBookPatternCommand
    );

    // 欢迎消息
    // vscode.window.showInformationMessage(
    //     'OM-TXT-Reader 已启动！按 Cmd/Ctrl+Shift+P，输入 "om-txt-reader: 打开阅读器" 开始使用'
    // );
}

export function deactivate() {
    readerProvider = undefined;
    bookshelfProvider = undefined;
    settingsProvider = undefined;
}
