import * as vscode from "vscode";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import hljs from "highlight.js";
import QRCode from "qrcode";
import { KeybindingChecker } from "./KeybindingChecker";
import { CryptoHelper } from "./crypto";
import { Mutex } from "async-mutex";

interface Bookmark {
    id: string;
    filePath: string; // 改为存储相对路径
    workspaceFolder?: string; // 新增工作区标识
    lineNumber: number;
    label?: string;
    isMatch?: boolean;
    isExpired?: boolean; // 新增过期状态
    codeHash?: string; // 新增代码哈希
    accessCount: number; // 新增访问次数统计
    lastAccessed?: number; // 最后访问时间戳
}

interface WorkspaceGroup extends vscode.TreeItem {
    type: "workspace";
    id: string;
    workspacePath: string;
    bookmarks: Bookmark[];
}

export class BookmarkProvider implements vscode.TreeDataProvider<Bookmark | WorkspaceGroup> {
    private storageMode: "global" | "workspace" = "workspace";
    private _onDidChangeTreeData = new vscode.EventEmitter<Bookmark | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private searchText: string = "";
    private _searchActive = false;
    private lastFilterCount = 0;
    private lastSearchCache = "";
    public bookmarks: Bookmark[] = [];
    private _isRefreshing = false;
    private _forceRefreshTimer: NodeJS.Timeout | null = null;
    private _fileWatcher?: vscode.FileSystemWatcher;
    private _disposables: vscode.Disposable[] = [];
    // 添加事件发射器
    private _onDidUpdateGraphData = new vscode.EventEmitter<void>();
    readonly onDidUpdateGraphData = this._onDidUpdateGraphData.event;
    private storageMutex = new Mutex(); // 文件操作互斥锁
    private pendingWrites = new Map<string, Bookmark[]>(); // 待写入队列
    public logger: vscode.OutputChannel;

    // 加密
    private async encryptBookmarks(data: Bookmark[]): Promise<string> {
        const config = vscode.workspace.getConfiguration("bookmark");
        if (!config.get("enableEncryption")) return JSON.stringify(data);

        try {
            const crypto = new CryptoHelper();
            return await crypto.encrypt(JSON.stringify(data));
        } catch (error) {
            vscode.window.showErrorMessage("加密失败: " + error);
            throw error;
        }
    }

    // 解密
    private async decryptBookmarks(data: string): Promise<Bookmark[]> {
        const config = vscode.workspace.getConfiguration("bookmark");
        if (!config.get("enableEncryption")) return JSON.parse(data);

        try {
            const crypto = new CryptoHelper();
            return JSON.parse(await crypto.decrypt(data));
        } catch (error) {
            vscode.window.showErrorMessage("解密失败，请检查加密密钥: " + error);
            return [];
        }
    }

    // 新增路径转换方法
    private getRelativePath(uri: vscode.Uri): string {
        const workspace = vscode.workspace.getWorkspaceFolder(uri);
        if (!workspace) return uri.fsPath; // 非工作区文件仍存绝对路径

        return path.relative(workspace.uri.fsPath, uri.fsPath);
    }

    public getAbsolutePath(bookmark: Bookmark): string {
        if (!bookmark.workspaceFolder) return bookmark.filePath;

        return path.join(bookmark.workspaceFolder, bookmark.filePath);
    }

    public updateGraphData() {
        this._onDidChangeTreeData.fire(undefined);
    }

    public getNodeScale(): number {
        const config = vscode.workspace.getConfiguration("bookmark.graphSettings");
        return config.get<number>("nodeScale") || 1.5;
    }

    private scheduleForceRefresh() {
        if (this._forceRefreshTimer) {
            clearTimeout(this._forceRefreshTimer);
        }
        this._forceRefreshTimer = setTimeout(() => {
            this._onDidChangeTreeData.fire(undefined);
        }, 50);
    }

    public validateBookmark(node: any): Bookmark | undefined {
        return this.bookmarks.find((b) => b.id === node?.id && typeof b.lineNumber === "number" && !!b.filePath);
    }

    // 新增状态同步方法
    resolveTreeItem(item: Bookmark | WorkspaceGroup, element: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem> {
        return element;
    }

    // 强制刷新视图状态
    public refreshView() {
        this.scheduleForceRefresh();
    }

    // 视图刷新
    public async refreshTreeView() {
        this._onDidChangeTreeData.fire(undefined);
        // 增加延迟确保视图更新完成
        await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // 新增搜索过滤方法：确保空字符串时状态正确
    public setSearchText(text: string) {
        this._searchActive = text.length > 0;
        this.searchText = text.toLowerCase();
        this._onDidChangeTreeData.fire(undefined);
    }

    // 书签计数
    public getFilteredCount(): number {
        if (this.lastSearchCache === "CLEAR_FLAG") {
            this.lastSearchCache = this.searchText;
            return 0;
        }

        if (this.lastSearchCache === this.searchText) {
            return this.lastFilterCount;
        }

        this.lastSearchCache = this.searchText;

        // 修改这里：无论是否激活搜索，只要没有搜索内容都返回0
        if (!this._searchActive) {
            this.lastFilterCount = 0; // 强制设为0
            return 0;
        }

        this.lastFilterCount = this.bookmarks.filter((b) => (b.label?.toLowerCase().includes(this.searchText) ?? false) || path.basename(b.filePath).toLowerCase().includes(this.searchText)).length;

        return this.lastFilterCount;
    }

    // 过滤书签获取
    public getFilteredBookmarks(): Bookmark[] {
        if (!this._searchActive) return this.bookmarks;

        return this.bookmarks.filter((b) => (b.label?.toLowerCase().includes(this.searchText) ?? false) || path.basename(b.filePath).toLowerCase().includes(this.searchText));
    }

    // 清除搜索
    public clearSearch() {
        this.searchText = "";
        this._searchActive = false;
        this.lastSearchCache = "CLEAR_FLAG";
        this.lastFilterCount = 0;
        this._onDidChangeTreeData.fire(undefined); // 强制刷新视图
    }

    private createHighlightDecoration() {
        const config = vscode.workspace.getConfiguration("bookmark");
        return vscode.window.createTextEditorDecorationType({
            backgroundColor: config.get("highlightColor") || "#157EFB22",
            isWholeLine: true,
        });
    }

    private decorationType!: vscode.TextEditorDecorationType;
    public highlightDecoration!: vscode.TextEditorDecorationType;

    constructor(private context: vscode.ExtensionContext) {
        // 新增日志通道初始化
        this.logger = vscode.window.createOutputChannel("Bookmark Logs");
        // 新增配置加载
        this.loadConfig();
        this.setupFileWatcher();
        hljs.configure({
            languages: ["javascript", "typescript", "python", "java", "cpp", "html", "css"],
        });
        // 初始化装饰器
        this.decorationType = vscode.window.createTextEditorDecorationType({
            gutterIconPath: path.join(this.context.extensionPath, "images", "bookmark-icon.png"),
            gutterIconSize: "contain",
        });
        this.highlightDecoration = this.createHighlightDecoration();
        this.loadBookmarks();
        context.globalState.setKeysForSync([this.getStorageKey()]); // 启用跨窗口同步

        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("bookmark.encryptionKey")) {
                vscode.window.showWarningMessage("加密密钥变更后，现有加密数据将无法解密！请谨慎操作！");
            }
            if (e.affectsConfiguration("bookmark.storageMode")) {
                this.loadConfig();
                this.loadBookmarks();
                this._onDidChangeTreeData.fire(undefined);
            }
            if (e.affectsConfiguration("bookmark")) {
                this.highlightDecoration.dispose();
                this.highlightDecoration = this.createHighlightDecoration();
            }
            if (e.affectsConfiguration("bookmark.groupSortOrder")) {
                this._onDidChangeTreeData.fire(undefined);
            }
            if (e.affectsConfiguration("bookmark.autoDetectChanges")) {
                this.setupFileWatcher();
            }
            if (e.affectsConfiguration("bookmark.graphSettings")) {
                this._onDidUpdateGraphData.fire();
            }
        });
        // 新增自动保存监听
        this._onDidChangeTreeData.event(() => {
            this.saveBookmarks().catch((error) => {
                console.error("自动保存失败:", error);
            });
        });
        // 添加文件重命名监听
        vscode.workspace.onDidRenameFiles(this.handleFileRename.bind(this));
        // 监听全局存储变化
        vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
            if (e.affectsConfiguration(this.getStorageKey())) {
                this.loadBookmarks().then(() => this._onDidChangeTreeData.fire(undefined));
            }
        });
    }

    // 新增配置加载方法
    private loadConfig() {
        this.storageMode = vscode.workspace.getConfiguration("bookmark").get("storageMode") || "workspace";
    }

    private async handleFileRename(event: vscode.FileRenameEvent) {
        for (const { oldUri, newUri } of event.files) {
            const oldPath = this.getRelativePath(oldUri);
            const newPath = this.getRelativePath(newUri);

            this.bookmarks.forEach((b) => {
                if (b.filePath === oldPath && b.workspaceFolder === vscode.workspace.getWorkspaceFolder(oldUri)?.uri.fsPath) {
                    b.filePath = newPath;
                    b.workspaceFolder = vscode.workspace.getWorkspaceFolder(newUri)?.uri.fsPath;
                }
            });
        }
        await this.saveBookmarks();
        this._onDidChangeTreeData.fire(undefined);
    }

    // 新增文件监听器管理
    private setupFileWatcher() {
        const config = vscode.workspace.getConfiguration("bookmark");
        if (config.get("autoDetectChanges")) {
            if (!this._fileWatcher) {
                this._fileWatcher = vscode.workspace.createFileSystemWatcher("**/*.*");
                this._fileWatcher.onDidChange((uri) => this.checkFileChanges(uri));
                this._disposables.push(this._fileWatcher);
            }
        } else {
            this._fileWatcher?.dispose();
            this._fileWatcher = undefined;
        }
    }

    // 新增变更检测方法
    private async checkFileChanges(uri: vscode.Uri) {
        const relativePath = this.getRelativePath(uri);
        const affectedBookmarks = this.bookmarks.filter((b) => b.filePath === relativePath && b.workspaceFolder === vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath);

        for (const bookmark of affectedBookmarks) {
            const doc = await vscode.workspace.openTextDocument(uri);
            const currentHash = this.getLineHash(doc, bookmark.lineNumber);

            if (currentHash !== bookmark.codeHash) {
                bookmark.isExpired = true;
                bookmark.codeHash = currentHash; // 更新为当前哈希
            }
        }

        this._onDidChangeTreeData.fire(undefined);
    }

    // 新增哈希生成方法
    public getLineHash(doc: vscode.TextDocument, lineNumber: number): string {
        const line = doc.lineAt(lineNumber);
        const hash = require("crypto").createHash("sha1");
        return hash.update(line.text).digest("hex").substr(0, 8);
    }

    async addBookmark() {
        try {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const uri = editor.document.uri;
            const workspace = vscode.workspace.getWorkspaceFolder(uri);

            const lineNumber = editor.selection.active.line;
            const bookmark: Bookmark = {
                id: uuidv4(),
                filePath: this.getRelativePath(uri),
                workspaceFolder: workspace?.uri.fsPath, // 存储工作区路径
                lineNumber: editor.selection.active.line,
                label: `Bookmark ${this.bookmarks.length + 1}`,
                accessCount: 0,
            };
            const doc = editor.document;
            const line = doc.lineAt(lineNumber);
            bookmark.codeHash = this.getLineHash(doc, lineNumber);

            this.bookmarks.push(bookmark);
            this.saveBookmarks();
            this.updateDecorations();
            this._onDidChangeTreeData.fire(undefined);
            this._onDidUpdateGraphData.fire();
        } catch (error) {
            const errorMsg = `添加书签失败: ${error instanceof Error ? error.message : error}`;
            vscode.window.showErrorMessage(errorMsg);
            this.logger.appendLine(`[${new Date().toISOString()}] 添加书签失败: ${errorMsg}`);
        }
    }

    removeBookmark(id: string) {
        this.bookmarks = this.bookmarks.filter((b) => b.id !== id);
        this.saveBookmarks();
        this.updateDecorations();
        this._onDidChangeTreeData.fire(undefined);
        this._onDidUpdateGraphData.fire();
    }

    clearAll() {
        this.bookmarks = [];
        this.saveBookmarks();
        this.updateDecorations();
        this._onDidChangeTreeData.fire(undefined);
    }

    renameBookmark(id: string, newLabel: string) {
        const bookmark = this.bookmarks.find((b) => b.id === id);
        if (bookmark) {
            bookmark.label = newLabel;
            this.saveBookmarks();
            this._onDidChangeTreeData.fire(undefined);
        }
    }

    public updateDecorations() {
        const ranges: vscode.DecorationOptions[] = [];
        this.bookmarks.forEach((bookmark) => {
            const range = new vscode.Range(new vscode.Position(bookmark.lineNumber, 0), new vscode.Position(bookmark.lineNumber, 0));
            ranges.push({ range });
        });
        vscode.window.activeTextEditor?.setDecorations(this.decorationType, ranges);
    }

    // 加载
    public async loadBookmarks() {
        const storageKey = this.getStorageKey();
        const release = await this.storageMutex.acquire(); // 获取锁

        try {
            const stored = this.context.globalState.get<string>(storageKey);
            if (stored) {
                this.bookmarks = await this.decryptBookmarks(stored);
            }
            // 合并待写入的修改
            if (this.pendingWrites.has(storageKey)) {
                this.bookmarks = this.mergeBookmarks2([...this.bookmarks, ...this.pendingWrites.get(storageKey)!]);
            }
        } finally {
            release(); // 释放锁
        }
    }

    private saveDebounceTimer: NodeJS.Timeout | null = null;
    public async saveBookmarks() {
        const storageKey = this.getStorageKey();
        const release = await this.storageMutex.acquire(); // 获取锁

        try {
            // 合并当前内存中的修改
            const pending = this.pendingWrites.get(storageKey) || [];
            const mergedBookmarks = this.mergeBookmarks2([...this.bookmarks, ...pending]);

            // 执行加密和写入
            const encryptedData = await this.encryptBookmarks(mergedBookmarks);
            await this.context.globalState.update(storageKey, encryptedData);

            // 清空待写入队列
            this.pendingWrites.delete(storageKey);
            this.bookmarks = mergedBookmarks;
        } catch (error) {
            const errorMsg = `保存失败: ${error instanceof Error ? error.message : error}`;
            vscode.window.showErrorMessage(errorMsg);

            // 记录详细错误日志
            this.logger.appendLine(`[${new Date().toISOString()}] 保存失败`);
            this.logger.appendLine(`错误信息: ${errorMsg}`);
            if (error instanceof Error && error.stack) {
                this.logger.appendLine(`堆栈跟踪: ${error.stack}`);
            }
            this.logger.appendLine("----------------------------------------");
        } finally {
            release(); // 释放锁
        }
    }

    // 新增合并方法 ▼▼▼
    private mergeBookmarks2(bookmarks: Bookmark[]): Bookmark[] {
        // 使用最后更新时间作为合并依据
        const bookmarkMap = new Map<string, Bookmark>();

        bookmarks.forEach((b) => {
            const existing = bookmarkMap.get(b.id);
            if (!existing || (b.lastAccessed || 0) > (existing.lastAccessed || 0)) {
                bookmarkMap.set(b.id, b);
            }
        });

        return Array.from(bookmarkMap.values());
    }

    // 新增存储键计算方法
    private getStorageKey(): string {
        if (this.storageMode === "global") return "bookmarks";

        // 确保不同工作区的存储键唯一
        const workspaceId = vscode.workspace.workspaceFolders?.[0]?.uri.toString() || "global";
        return `bookmarks_${workspaceId}_${this.storageMode}`;
    }

    private async generateHighlightHtml(code: string, language: string): Promise<string> {
        if (!hljs.getLanguage(language)) {
            language = ""; // 清空语言触发自动检测
        }
        try {
            // 自动检测语言
            const result = language ? hljs.highlight(code, { language, ignoreIllegals: true }) : hljs.highlightAuto(code);

            // 动态获取当前主题
            const isDarkTheme = await this.isDarkTheme();
            const themeClass = isDarkTheme ? "vscode-dark" : "vscode-light";

            return `
                <pre class="hljs ${themeClass}" style="
                    background: var(--vscode-editor-background);
                    padding: 10px;
                    border-radius: 4px;
                    overflow: hidden;
                ">
                    <code>${result.value}</code>
                </pre>
            `;
        } catch {
            return `<pre style="color:var(--vscode-editor-foreground)">${code}</pre>`;
        }
    }

    private async isDarkTheme(): Promise<boolean> {
        const config = vscode.workspace.getConfiguration();
        const theme = config.get<string>("workbench.colorTheme", "").toLowerCase();
        return theme.includes("dark");
    }

    private htmlToSvg(
        html: string,
        options: {
            width: number;
            height: number;
            fontFamily: string;
            fontSize: number;
        }
    ): string {
        // 提高基础分辨率和缩放比例
        const scale = 2; // 从1.5提升到2
        const scaledWidth = options.width * scale;
        const scaledHeight = options.height * scale;
        const svgContent = `
        <svg xmlns="http://www.w3.org/2000/svg" 
            width="${scaledWidth}" 
            height="${scaledHeight}"
            viewBox="0 0 ${scaledWidth} ${scaledHeight}">
            <foreignObject width="100%" height="100%">
                <div xmlns="http://www.w3.org/1999/xhtml"
                    style="
                        font-family: ${options.fontFamily};
                        font-size: ${options.fontSize * scale}px;
                        line-height: 1.5em;
                        padding: 20px;
                        background: var(--vscode-editor-background);
                        color: var(--vscode-editor-foreground);
                        border-radius: 6px;
                        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
                    ">
                    ${html}
                </div>
            </foreignObject>
        </svg>
    `;

        return svgContent;
    }

    // 修改getChildren方法签名
    getChildren(element?: Bookmark | WorkspaceGroup): vscode.ProviderResult<Array<Bookmark | WorkspaceGroup>> {
        if (element) {
            // 当element是分组时，直接返回该分组的书签列表
            const group = element as WorkspaceGroup;
            return group.bookmarks;
        }
        // 根节点返回所有分组
        return this.getWorkspaceGroups();
    }

    // 修改getTreeItem方法
    getTreeItem(element: Bookmark | WorkspaceGroup): vscode.TreeItem {
        if (this._isRefreshing && !element) {
            return {
                label: "正在刷新...",
                iconPath: new vscode.ThemeIcon("loading~spin"),
            };
        }

        // 处理工作区分组
        if ("type" in element && element.type === "workspace") {
            const group = element as WorkspaceGroup;
            const treeItem = new vscode.TreeItem(group.label || "", vscode.TreeItemCollapsibleState.Expanded);
            treeItem.iconPath = group.iconPath;
            treeItem.contextValue = "workspaceGroup";
            return treeItem;
        }

        // 处理书签项 ▼▼▼ 以下是重点修改部分 ▼▼▼
        const bookmark = element as Bookmark;
        const isMatch = this._searchActive && (bookmark.label?.toLowerCase().includes(this.searchText) || path.basename(bookmark.filePath).toLowerCase().includes(this.searchText));
        // 处理书签项
        const statusIcon = bookmark.isExpired ? "🔄 " : "";
        // 创建基础TreeItem
        const item = new vscode.TreeItem(`${statusIcon}${bookmark.label} (Line ${bookmark.lineNumber + 1})`, vscode.TreeItemCollapsibleState.None);
        // 设置图标和工具提示
        item.iconPath = vscode.ThemeIcon.File;
        item.contextValue = "bookmark";

        // 设置其他属性
        item.description = isMatch ? vscode.l10n.t("🔍 Match") : undefined;
        const absPath = this.getAbsolutePath(bookmark);
        item.resourceUri = vscode.Uri.file(absPath);
        const baseContext = "bookmark";
        item.contextValue = `${baseContext}${bookmark.isExpired ? "-expired" : ""}`;
        item.command = {
            command: "bookmark.navigate",
            title: "导航并高亮",
            arguments: [bookmark],
        };

        // 添加过期状态工具提示
        if (bookmark.isExpired) {
            item.tooltip = new vscode.MarkdownString(`**该书签可能已过期**\n\n` + `检测到文件内容已变更，请确认书签有效性。\n\n` + `[点击修复位置](command:bookmark.fixPosition?${encodeURIComponent(JSON.stringify(bookmark.id))})`);
        }

        return item;
    }

    // 新增方法：获取全部书签（按文件路径和行号排序）
    public getAllSortedBookmarks(): Bookmark[] {
        return [...this.bookmarks].sort((a, b) => {
            const pathCompare = a.filePath.localeCompare(b.filePath);
            return pathCompare !== 0 ? pathCompare : a.lineNumber - b.lineNumber;
        });
    }

    // 新增方法：转换为可导航的书签对象
    public createNavigableBookmark(bookmark: Bookmark) {
        return {
            uri: vscode.Uri.file(bookmark.filePath),
            position: new vscode.Position(bookmark.lineNumber, 0),
            data: bookmark,
        };
    }

    // 新增导出方法
    public async exportToMarkdown() {
        const content = this.bookmarks
            .map((b) => {
                return `| ${b.label} | ${path.basename(b.filePath)} | ${b.lineNumber + 1} | \`${b.filePath}\` |`;
            })
            .join("\n");

        // 优化表格样式
        const header = `| 名称 | 文件 | 行号 | 路径 | 
    |------|------|-----|------|----------|`;

        const fullContent = `${header}\n${content}`;

        const uri = await vscode.window.showSaveDialog({
            filters: { Markdown: ["md"] },
            title: "Export Bookmarks",
        });

        if (uri) {
            try {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(fullContent));
                vscode.window.showInformationMessage(`Exported ${this.bookmarks.length} bookmarks`);
                this._onDidChangeTreeData.fire(undefined);
            } catch (error) {
                vscode.window.showErrorMessage(`Export failed: ${error}`);
            }
        }
    }

    // 新增导入方法
    public async importFromMarkdown(uri: vscode.Uri) {
        try {
            const content = await vscode.workspace.fs.readFile(uri);
            const lines = content.toString().split("\n").slice(2); // 跳过表头

            const newBookmarks = lines
                .map((line) => {
                    const match = line.match(/\| (.+?) \| (.+?) \| Line (\d+) \| `(.+?)` \|/);
                    if (match) {
                        return {
                            id: uuidv4(),
                            label: match[1],
                            filePath: match[4],
                            lineNumber: parseInt(match[3]) - 1,
                        };
                    }
                    return null;
                })
                .filter(Boolean) as Bookmark[];

            // 合并去重
            const existingPaths = new Set(this.bookmarks.map((b) => `${b.filePath}:${b.lineNumber}`));
            const uniqueBookmarks = newBookmarks.filter((b) => !existingPaths.has(`${b.filePath}:${b.lineNumber}`));

            this.bookmarks.push(...uniqueBookmarks);
            await this.saveBookmarks();
            this._onDidChangeTreeData.fire(undefined);
            vscode.window.showInformationMessage(`Imported ${uniqueBookmarks.length} bookmarks`);
        } catch (error) {
            vscode.window.showErrorMessage(`Import failed: ${error}`);
        }
    }

    // 修改导入方法
    public async importBookmarks() {
        const uri = await vscode.window.showOpenDialog({
            filters: {
                支持的文件类型: ["md", "json", "csv", "txt"],
                Markdown: ["md"],
                JSON: ["json"],
                CSV: ["csv"],
                Text: ["txt"],
            },
            title: "导入书签",
            canSelectMany: false,
        });

        if (uri && uri[0]) {
            const fileExt = uri[0].path.split(".").pop()?.toLowerCase();

            switch (fileExt) {
                case "json":
                    return this.importFromJSON(uri[0]);
                case "csv":
                    return this.importFromCSV(uri[0]);
                case "txt":
                    return this.importFromTXT(uri[0]);
                case "md":
                    return this.importFromMarkdown(uri[0]);
            }
        }
    }

    // 新增JSON导入
    private async importFromJSON(uri: vscode.Uri) {
        const content = await vscode.workspace.fs.readFile(uri);
        const data = JSON.parse(content.toString());

        const newBookmarks = data.map((item: any) => ({
            id: uuidv4(),
            label: item.label,
            filePath: item.path,
            lineNumber: (item.line || 1) - 1,
        }));

        await this.mergeBookmarks(newBookmarks);
    }

    // 新增CSV导入
    private async importFromCSV(uri: vscode.Uri) {
        const content = await vscode.workspace.fs.readFile(uri);
        const lines = content.toString().split("\n").slice(1); // 跳过表头

        const newBookmarks = lines
            .map((line) => {
                const [label, _, lineStr, filePath] = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
                return {
                    id: uuidv4(),
                    label: label.replace(/^"|"$/g, ""),
                    filePath: filePath.replace(/^"|"$/g, ""),
                    lineNumber: parseInt(lineStr) - 1,
                    accessCount: 0,
                };
            })
            .filter((b: Bookmark) => b.filePath);

        await this.mergeBookmarks(newBookmarks);
    }

    // 新增TXT导入
    private async importFromTXT(uri: vscode.Uri) {
        const content = await vscode.workspace.fs.readFile(uri);
        const blocks = content.toString().split("\n" + "-".repeat(50) + "\n");

        const newBookmarks = blocks
            .map((block) => {
                const match = block.match(/(.+?)\s+\[Line\s(\d+)\]\n(.+)/);
                return match
                    ? {
                          id: uuidv4(),
                          label: match[1].trim(),
                          filePath: match[3].trim(),
                          lineNumber: parseInt(match[2]) - 1,
                          accessCount: 0,
                      }
                    : null;
            })
            .filter(Boolean) as Bookmark[];

        await this.mergeBookmarks(newBookmarks);
    }

    // 通用合并书签方法
    private async mergeBookmarks(newBookmarks: Bookmark[]) {
        try {
            const existing = new Set(this.bookmarks.map((b) => `${b.filePath}:${b.lineNumber}`));
            const unique = newBookmarks.filter((b) => !existing.has(`${b.filePath}:${b.lineNumber}`));

            this.bookmarks.push(...unique);
            await this.saveBookmarks(); // 确保等待保存完成
            this._onDidChangeTreeData.fire(undefined);
            vscode.window.showInformationMessage(`成功导入 ${unique.length} 个书签`);
        } catch (error) {
            vscode.window.showErrorMessage(`保存失败: ${error}`);
        }
    }

    // 新增排序方法
    private sortGroups(groups: WorkspaceGroup[]): WorkspaceGroup[] {
        const config = vscode.workspace.getConfiguration("bookmark");
        const sortOrder = config.get<string>("groupSortOrder") || "name-asc";

        return groups.sort((a, b) => {
            // 提取排序方式和方向
            const [sortBy, direction] = sortOrder.split("-");
            const modifier = direction === "desc" ? -1 : 1;

            switch (sortBy) {
                case "count":
                    return (b.bookmarks.length - a.bookmarks.length) * modifier;

                case "path":
                    const aPath = a.workspacePath.toLowerCase();
                    const bPath = b.workspacePath.toLowerCase();
                    return aPath.localeCompare(bPath) * modifier;

                default: // name
                    return (a.label as string).localeCompare(b.label as string) * modifier;
            }
        });
    }

    public getWorkspaceGroups(): WorkspaceGroup[] {
        const visibleBookmarks = this.bookmarks.filter((b) => this.storageMode === "global" || !b.workspaceFolder || b.workspaceFolder === vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
        const workspaceFolders = vscode.workspace.workspaceFolders || [];
        let filteredBookmarks = visibleBookmarks;

        // ▼▼▼ 原有过滤逻辑 ▼▼▼
        if (this.searchText) {
            filteredBookmarks = visibleBookmarks
                .map((b) => ({
                    ...b,
                    isMatch: !!(b.label?.toLowerCase().includes(this.searchText) || path.basename(b.filePath).toLowerCase().includes(this.searchText)),
                }))
                .filter((b) => b.isMatch);
        }

        // ▼▼▼ 原有分组创建逻辑 ▼▼▼
        const newGroups = workspaceFolders
            .map((folder) => {
                // 新增：过滤当前工作区的书签
                const groupBookmarks = filteredBookmarks.filter((b) => path.relative(folder.uri.fsPath, b.filePath).startsWith("..") === false);
                return groupBookmarks.length > 0
                    ? {
                          type: "workspace" as const,
                          id: folder.uri.toString(),
                          label: `${path.basename(folder.uri.fsPath)} (${groupBookmarks.length}) → ${folder.uri.fsPath}`, // 显示完整路径
                          workspacePath: folder.uri.fsPath,
                          bookmarks: groupBookmarks,
                          collapsibleState: vscode.TreeItemCollapsibleState.Expanded, // 修改这里
                          iconPath: {
                              light: vscode.Uri.file(path.join(this.context.extensionPath, "images", "folder-light.svg")),
                              dark: vscode.Uri.file(path.join(this.context.extensionPath, "images", "folder-dark.svg")),
                          },
                      }
                    : null;
            })
            .filter(Boolean) as WorkspaceGroup[];

        // ▼▼▼ 处理未分组书签（添加唯一标识）▼▼▼
        const ungrouped = filteredBookmarks.filter((b) => !workspaceFolders.some((folder) => !path.relative(folder.uri.fsPath, b.filePath).startsWith("..")));

        if (ungrouped.length > 0) {
            newGroups.push({
                type: "workspace" as const,
                id: "ungrouped", // 特殊标识符
                label: `其他书签 (${ungrouped.length})`,
                workspacePath: "",
                bookmarks: ungrouped,
                collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
                iconPath: {
                    light: vscode.Uri.file(path.join(this.context.extensionPath, "images", "other-light.svg")),
                    dark: vscode.Uri.file(path.join(this.context.extensionPath, "images", "other-dark.svg")),
                },
            });
        }

        return this.sortGroups(newGroups);
    }

    // 新增通用导出方法
    public async exportBookmarks() {
        const config = vscode.workspace.getConfiguration("bookmark");
        const defaultFormat = config.get<string>("exportFormat") || "markdown";

        // 让用户选择格式
        const format = await vscode.window.showQuickPick(
            [
                { label: "Markdown", description: ".md" },
                { label: "JSON", description: ".json" },
                { label: "CSV", description: ".csv" },
                { label: "Plain Text", description: ".txt" },
            ],
            {
                placeHolder: `选择导出格式（当前默认：${defaultFormat}）`,
                ignoreFocusOut: true,
            }
        );

        if (!format) return;

        // 根据选择调用不同导出方法
        switch (format.label.toLowerCase()) {
            case "json":
                return this.exportToJSON();
            case "csv":
                return this.exportToCSV();
            case "plain text":
                return this.exportToTXT();
            default:
                return this.exportToMarkdown();
        }
    }

    // 新增JSON导出
    private async exportToJSON() {
        const exportData = this.bookmarks.map((b) => ({
            label: b.label,
            path: b.filePath,
            line: b.lineNumber + 1,
            id: b.id,
        }));

        const content = JSON.stringify(exportData, null, 2);
        const uri = await this.showSaveDialog("JSON", "json");
        if (uri) {
            await this.writeFileWithFeedback(uri, content, "JSON");
        }
    }

    // 新增CSV导出
    private async exportToCSV() {
        const header = "Label,File,Line,Path,ID";
        const content = this.bookmarks.map((b) => `"${b.label}","${path.basename(b.filePath)}",${b.lineNumber + 1},"${b.filePath}","${b.id}"`).join("\n");

        const uri = await this.showSaveDialog("CSV", "csv");
        if (uri) {
            await this.writeFileWithFeedback(uri, `${header}\n${content}`, "CSV");
        }
    }

    // 新增TXT导出
    private async exportToTXT() {
        const content = this.bookmarks.map((b) => `${b.label} [Line ${b.lineNumber + 1}]\n${b.filePath}\n${"-".repeat(50)}`).join("\n\n");

        const uri = await this.showSaveDialog("Text", "txt");
        if (uri) {
            await this.writeFileWithFeedback(uri, content, "Text");
        }
    }

    // 通用保存对话框
    private async showSaveDialog(formatName: string, ext: string) {
        return vscode.window.showSaveDialog({
            filters: { [formatName]: [ext] },
            title: `导出书签为${formatName}`,
            defaultUri: vscode.Uri.file(`bookmarks-${new Date().toISOString().slice(0, 10)}.${ext}`),
        });
    }

    // 通用文件写入
    private async writeFileWithFeedback(uri: vscode.Uri, content: string, formatName: string) {
        try {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(content));
            vscode.window.showInformationMessage(`成功导出 ${this.bookmarks.length} 个书签为${formatName}格式`);
            this._onDidChangeTreeData.fire(undefined);
        } catch (error) {
            vscode.window.showErrorMessage(`${formatName}导出失败: ${error}`);
        }
    }

    // 分享
    public async generateBookmarkQR(bookmark: Bookmark): Promise<string> {
        try {
            const content = JSON.stringify(
                {
                    type: "vscode-bookmark",
                    version: 1,
                    data: {
                        label: bookmark.label,
                        path: bookmark.filePath,
                        line: bookmark.lineNumber + 1,
                    },
                },
                null,
                2
            );

            return await QRCode.toDataURL(content, {
                errorCorrectionLevel: "H",
                type: "image/png",
                margin: 2,
                scale: 8,
                color: {
                    dark: "#000000FF",
                    light: "#FFFFFFFF",
                },
            });
        } catch (error) {
            vscode.window.showErrorMessage(`生成二维码失败: ${error}`);
            throw error;
        }
    }

    // 新增数据统计方法
    public getGraphData() {
        const files = new Map<
            string,
            {
                bookmarks: Bookmark[];
                links: Map<string, number>;
            }
        >();

        // 统计文件关联度
        this.bookmarks.forEach((b) => {
            if (!files.has(b.filePath)) {
                files.set(b.filePath, {
                    bookmarks: [],
                    links: new Map<string, number>(),
                });
            }
            const file = files.get(b.filePath)!;
            file.bookmarks.push(b);
        });

        // 计算文件关联度（基于共享书签数）
        Array.from(files.keys()).forEach((sourcePath) => {
            Array.from(files.keys()).forEach((targetPath) => {
                if (sourcePath !== targetPath) {
                    const shared = this.bookmarks.filter((b) => b.filePath === sourcePath || b.filePath === targetPath).length;
                    files.get(sourcePath)!.links.set(targetPath, shared);
                }
            });
        });
        return {
            nodes: this.bookmarks.map((b) => ({
                id: b.id,
                label: b.label,
                path: b.filePath,
                size: Math.sqrt(b.accessCount + 1) * 2 * this.getNodeScale() + 2, // 更好的尺寸计算
                group: path.dirname(b.filePath), // 按目录分组
            })),
            links: Array.from(files.entries()).flatMap(([source, data]) =>
                Array.from(data.links.entries()).map(([target, weight]) => ({
                    source: source,
                    target: target,
                    value: Math.log(weight + 1), // 对数缩放关联强度
                }))
            ),
        };
    }

    // 更新访问统计
    public recordAccess(id: string) {
        const bookmark = this.bookmarks.find((b) => b.id === id);
        if (bookmark) {
            bookmark.accessCount = (bookmark.accessCount || 0) + 1;
            bookmark.lastAccessed = Date.now();
            this.saveBookmarks().catch((error) => {
                // 添加错误捕获
                vscode.window.showErrorMessage(`访问统计保存失败: ${error}`);
            });
        }
    }

    // 添加强制立即保存方法
    public async forceSaveBookmarks() {
        if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
            this.saveDebounceTimer = null;
        }
        await this.context.globalState.update("bookmarks", this.bookmarks);
    }

    // 添加文件监听器清理方法
    public disposeFileWatcher() {
        this._fileWatcher?.dispose();
        this._fileWatcher = undefined;
    }
}

export function activate(context: vscode.ExtensionContext) {
    const checker = new KeybindingChecker(context);
    // 延迟 3 秒检测以避免影响启动性能
    setTimeout(() => {
        checker.showConflictNotification();
    }, 3000);

    const bookmarkProvider = new BookmarkProvider(context);
    const treeView = vscode.window.createTreeView("bookmarkView", {
        treeDataProvider: bookmarkProvider,
    });
    // 单独设置徽章属性
    treeView.badge = {
        tooltip: "当前书签总数：",
        value: bookmarkProvider.bookmarks.length,
    };
    // 添加数据变化监听
    context.subscriptions.push(
        bookmarkProvider.onDidChangeTreeData(() => {
            treeView.badge = {
                tooltip: `当前书签总数：${bookmarkProvider.bookmarks.length}`,
                value: bookmarkProvider.bookmarks.length,
            };
        })
    );
    // 添加视图可见性监听自动展开
    treeView.onDidChangeVisibility((e) => {
        if (e.visible) {
            // 延迟500ms确保视图加载完成
            setTimeout(() => {
                bookmarkProvider.getWorkspaceGroups().forEach((group) => {
                    treeView.reveal(group, { expand: true });
                });
            }, 500);
        }
    });

    // 添加搜索框处理逻辑
    const quickPick = vscode.window.createQuickPick();
    quickPick.placeholder = "输入书签名称/文件名进行筛选";
    quickPick.onDidChangeValue((value) => {
        bookmarkProvider.setSearchText(value);
        // 显示实时匹配数量
        quickPick.items = [
            {
                label: `当前匹配: ${bookmarkProvider.getFilteredCount()}个书签`,
                alwaysShow: true,
            },
        ];
    });
    // 键盘导航
    quickPick.onDidAccept(() => {
        const items = bookmarkProvider.getFilteredBookmarks(); // 改用过滤后的书签
        if (items.length > 0) {
            vscode.commands.executeCommand("bookmark.navigate", items[0]);
        }
        quickPick.hide();
    });

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider("bookmarkView", bookmarkProvider),
        vscode.commands.registerCommand("bookmark.add", () => bookmarkProvider.addBookmark()),
        vscode.commands.registerCommand("bookmark.remove", (node: Bookmark) => {
            bookmarkProvider.removeBookmark(node.id);
        }),
        vscode.commands.registerCommand("bookmark.clearAll", () => bookmarkProvider.clearAll()),
        vscode.commands.registerCommand("bookmark.rename", (node: Bookmark) => {
            vscode.window.showInputBox({ prompt: "请输入书签名称：" }).then((newName) => {
                if (newName) {
                    bookmarkProvider.renameBookmark(node.id, newName);
                }
            });
        }),
        vscode.commands.registerCommand("bookmark.removeFromTree", (node: Bookmark) => {
            bookmarkProvider.removeBookmark(node.id);
        }),
        // 导航命令代码
        vscode.commands.registerCommand("bookmark.navigate", async (bookmark: Bookmark) => {
            const absPath = bookmarkProvider.getAbsolutePath(bookmark);
            const uri = vscode.Uri.file(absPath);
            const editor = await vscode.window.showTextDocument(uri);
            const position = new vscode.Position(bookmark.lineNumber, 0);

            bookmarkProvider.recordAccess(bookmark.id);
            // 显示静态高亮（3秒自动清除）
            const staticHighlight = bookmarkProvider.highlightDecoration;
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            editor.setDecorations(staticHighlight, [new vscode.Range(position, position)]);

            // 设置3秒后清除静态高亮
            setTimeout(() => {
                editor.setDecorations(staticHighlight, []);
            }, 3000);

            // 动画实现（保持原有时长配置）
            const config = vscode.workspace.getConfiguration("bookmark");
            const duration = config.get<number>("highlightDuration", 3000);
            const startTime = Date.now();
            let animationFrame: NodeJS.Timeout | null = null;
            let prevDecoration: vscode.TextEditorDecorationType | undefined;

            const animate = () => {
                const elapsed = Date.now() - startTime;
                const progress = Math.min(elapsed / duration, 1);
                const alpha = 0.3 * (1 - progress);

                // 创建新装饰器
                const dynamicDecoration = vscode.window.createTextEditorDecorationType({
                    backgroundColor: `rgba(255,255,0,${alpha})`,
                    isWholeLine: true,
                });

                // 应用并清理装饰器
                editor.setDecorations(dynamicDecoration, [new vscode.Range(position, position)]);
                if (prevDecoration) prevDecoration.dispose();
                prevDecoration = dynamicDecoration;
            };

            // 启动动画（调整帧率为30fps）
            animationFrame = setInterval(animate, 33); // 1000ms/30 ≈ 33ms
        }),
        // 跳转到下一个书签
        vscode.commands.registerCommand("bookmark.next", async () => {
            const bookmarks = bookmarkProvider.getAllSortedBookmarks();
            if (bookmarks.length === 0) {
                vscode.window.showInformationMessage("No bookmarks available");
                return;
            }

            const currentEditor = vscode.window.activeTextEditor;
            const currentUri = currentEditor?.document.uri;
            const currentLine = currentEditor?.selection.active.line ?? -1;

            // 转换所有书签为可导航格式
            const navigableBookmarks = bookmarks.map((b) => bookmarkProvider.createNavigableBookmark(b));

            // 查找下一个书签
            const next =
                navigableBookmarks.find((b) => {
                    const isSameFile = b.uri.toString() === currentUri?.toString();
                    return (!isSameFile && currentUri) || (isSameFile && b.position.line > currentLine);
                }) || navigableBookmarks[0]; // 循环到第一个

            await navigateToBookmark(next);
        }),
        // 跳转到上一个书签
        vscode.commands.registerCommand("bookmark.previous", async () => {
            const bookmarks = bookmarkProvider.getAllSortedBookmarks();
            if (bookmarks.length === 0) {
                vscode.window.showInformationMessage("No bookmarks available");
                return;
            }

            const currentEditor = vscode.window.activeTextEditor;
            const currentUri = currentEditor?.document.uri;
            const currentLine = currentEditor?.selection.active.line ?? -1;

            // 转换所有书签为可导航格式（逆序）
            const navigableBookmarks = [...bookmarks].reverse().map((b) => bookmarkProvider.createNavigableBookmark(b));

            // 查找上一个书签
            const previous =
                navigableBookmarks.find((b) => {
                    const isSameFile = b.uri.toString() === currentUri?.toString();
                    return (!isSameFile && currentUri) || (isSameFile && b.position.line < currentLine);
                }) || navigableBookmarks[0]; // 循环到最后一个

            await navigateToBookmark(previous);
        }),
        // 替换原有export/import命令
        vscode.commands.registerCommand("bookmark.export", () => bookmarkProvider.exportBookmarks()),
        vscode.commands.registerCommand("bookmark.import", () => bookmarkProvider.importBookmarks()),
        // 帮助
        vscode.commands.registerCommand("bookmark.help", () => {
            vscode.env.openExternal(vscode.Uri.parse("https://github.com/Vogadero/bookmark"));
        }),
        // 搜索
        vscode.commands.registerCommand("bookmark.search", () => {
            quickPick.value = ""; // 清空输入框
            bookmarkProvider.clearSearch(); // 重置搜索状态
            // 先设置空数组强制清空显示
            quickPick.items = [];
            // 延迟10ms等待状态更新后设置初始值
            setTimeout(() => {
                quickPick.items = [
                    {
                        label: `当前匹配: ${bookmarkProvider.getFilteredCount()}个书签`, // 这里改为调用方法
                        alwaysShow: true,
                    },
                ];
            }, 10);
            quickPick.show();
        }),
        // 重置
        vscode.commands.registerCommand("bookmark.clear", () => {
            bookmarkProvider.setSearchText("");
            quickPick.value = "";
            quickPick.hide();
        }),
        // 新增刷新命令 ▼▼▼
        vscode.commands.registerCommand("bookmark.refresh", async () => {
            // 显示进度通知
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: "刷新中",
                    cancellable: false,
                },
                async (progress) => {
                    // 模拟分步进度
                    progress.report({ message: "正在更新书签视图..." });
                    await bookmarkProvider.refreshView();

                    // 保持进度显示至少500ms避免闪烁
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
            );
            bookmarkProvider.setSearchText("");
            quickPick.value = "";
            quickPick.hide();
        }),
        // 保留原有的视图刷新命令（如果其他位置需要）
        vscode.commands.registerCommand("bookmarkView.refresh", () => {
            bookmarkProvider.refreshView();
        }),
        // 设置
        vscode.commands.registerCommand("bookmark.set", () => {
            const extensionId = context.extension.id;
            vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${extensionId}`);
        }),
        // 分享
        vscode.commands.registerCommand("bookmark.share", async (node: Bookmark) => {
            const validBookmark = bookmarkProvider.validateBookmark(node);
            if (!validBookmark) {
                vscode.window.showErrorMessage("请先选择有效书签");
                return;
            }
            if (!node) {
                const selection = await vscode.window.showQuickPick(
                    bookmarkProvider.bookmarks.map((b) => b.label || `无名称书签 (行 ${b.lineNumber + 1})`),
                    { placeHolder: "请选择要分享的书签" }
                );
                if (!selection) return;
                node = bookmarkProvider.bookmarks.find((b) => b.label === selection)!;
            }

            if (!node?.label) {
                vscode.window.showErrorMessage("请右键点击书签项进行分享");
                return;
            }
            const panel = vscode.window.createWebviewPanel("bookmarkQR", `分享书签 - ${node.label}`, vscode.ViewColumn.Beside, {
                enableScripts: true,
                retainContextWhenHidden: true,
            });

            try {
                const qrData = await bookmarkProvider.generateBookmarkQR(node);
                panel.webview.html = getShareWebviewContent(qrData, node);
            } catch (error) {
                panel.webview.html = `<p>无法生成分享二维码：${error}</p>`;
            }
        }),
        // 新增修复位置命令
        vscode.commands.registerCommand("bookmark.fixPosition", async (id: string) => {
            const bookmark = bookmarkProvider.bookmarks.find((b) => b.id === id);
            if (!bookmark) return;

            const editor = await vscode.window.showTextDocument(vscode.Uri.file(bookmark.filePath));
            const newLine = editor.selection.active.line;

            bookmark.lineNumber = newLine;
            bookmark.isExpired = false;
            bookmark.codeHash = bookmarkProvider.getLineHash(editor.document, newLine);

            bookmarkProvider.saveBookmarks();
            bookmarkProvider.refreshView();
        }),
        // 新增手动检测命令
        vscode.commands.registerCommand("bookmark.checkValidity", async () => {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: "正在检查书签有效性...",
                },
                async () => {
                    const docs = new Map<string, vscode.TextDocument>();

                    for (const b of bookmarkProvider.bookmarks) {
                        try {
                            if (!docs.has(b.filePath)) {
                                docs.set(b.filePath, await vscode.workspace.openTextDocument(b.filePath));
                            }

                            const doc = docs.get(b.filePath)!;
                            const currentHash = bookmarkProvider.getLineHash(doc, b.lineNumber);
                            b.isExpired = currentHash !== b.codeHash;
                        } catch {
                            b.isExpired = true;
                        }
                    }

                    bookmarkProvider.refreshView();
                }
            );
        }),
        // 数据迁移
        vscode.commands.registerCommand("bookmark.migrateData", async () => {
            const answer = await vscode.window.showQuickPick(["迁移到全局存储", "迁移到工作区存储"], { placeHolder: "选择数据迁移方向" });

            if (!answer) return;

            const oldKey = answer.includes("全局") ? `bookmarks_${vscode.workspace.workspaceFolders?.[0]?.uri.toString()}` : "bookmarks";

            const newKey = answer.includes("全局") ? "bookmarks" : `bookmarks_${vscode.workspace.workspaceFolders?.[0]?.uri.toString()}`;

            const data = context.globalState.get<Bookmark[]>(oldKey) || [];
            await context.globalState.update(newKey, data);
            await context.globalState.update(oldKey, undefined);

            bookmarkProvider.loadBookmarks();
            bookmarkProvider.refreshView();
        }),
        // 密钥
        vscode.commands.registerCommand("bookmark.manageEncryption", async () => {
            const config = vscode.workspace.getConfiguration("bookmark");
            const currentKey = config.get("encryptionKey") || "未设置";

            const choice = await vscode.window.showQuickPick(["生成新密钥", "查看当前密钥", "重置加密配置"]);

            if (choice === "生成新密钥") {
                const crypto = new CryptoHelper();
                const newKey = crypto.generateKey();
                await config.update("encryptionKey", newKey, true);
                vscode.window.showInformationMessage("新密钥已生成，请妥善保存！");
            }

            if (choice === "查看当前密钥") {
                vscode.window.showInformationMessage(`当前加密密钥：${currentKey}`);
            }

            if (choice === "重置加密配置") {
                await config.update("encryptionKey", undefined, true);
                await config.update("enableEncryption", false, true);
                vscode.window.showInformationMessage("加密配置已重置");
            }
        }),
        // 日志
        vscode.commands.registerCommand("bookmark.showLogs", () => {
            bookmarkProvider.logger.show();
        })
    );

    // 将inputBox加入订阅列表
    context.subscriptions.push(quickPick);

    // 监听编辑器切换事件更新装饰
    vscode.window.onDidChangeActiveTextEditor(() => {
        bookmarkProvider.updateDecorations();
    });

    // 新增导航辅助函数
    async function navigateToBookmark(target: { uri: vscode.Uri; position: vscode.Position; data: Bookmark }) {
        const editor = await vscode.window.showTextDocument(target.uri);
        const revealRange = new vscode.Range(target.position, target.position);

        // 高亮显示
        editor.revealRange(revealRange, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(target.position, target.position);

        // 触发导航动画（复用现有逻辑）
        vscode.commands.executeCommand("bookmark.navigate", target.data);
    }

    context.subscriptions.push(
        vscode.commands.registerCommand("bookmark.fixConflicts", async () => {
            const fixed = await checker.fixConflicts();
            vscode.window.showInformationMessage(`已修复 ${fixed} 个快捷键冲突，需要重载窗口生效`, "立即重载").then((choice) => {
                if (choice === "立即重载") {
                    vscode.commands.executeCommand("workbench.action.reloadWindow");
                }
            });
        })
    );

    // 3D可视化命令
    context.subscriptions.push(
        vscode.commands.registerCommand("bookmark.showGraph", () => {
            const panel = vscode.window.createWebviewPanel("bookmarkGraph", "书签关系图", vscode.ViewColumn.Two, {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "node_modules")), vscode.Uri.file(path.join(context.extensionPath, "media"))],
            });

            // 新增数据获取逻辑
            const graphData = bookmarkProvider.getGraphData();

            // 初始化加载状态
            panel.webview.html = `<div style="color:var(--vscode-editor-foreground)">正在加载可视化组件...</div>`;

            // 配置监听（带防抖）
            let updateTimeout: NodeJS.Timeout;
            const configDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration("bookmark.graphSettings.layout")) {
                    const newLayout = vscode.workspace.getConfiguration("bookmark.graphSettings").get("layout");
                    panel.webview.postMessage({
                        command: "changeLayout",
                        layout: newLayout,
                    });
                }
            });

            // 数据更新监听
            const updateGraph = () => {
                const newData = bookmarkProvider.getGraphData();
                panel.webview.postMessage({
                    command: "updateData",
                    data: newData,
                });
            };

            // 带防抖的配置更新
            const editorChangeDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration("bookmark.graphSettings")) {
                    clearTimeout(updateTimeout);
                    updateTimeout = setTimeout(updateGraph, 300);
                }
            });

            // 资源清理
            panel.onDidDispose(() => {
                configDisposable.dispose();
                editorChangeDisposable.dispose();
                clearTimeout(updateTimeout);
            });

            // 生成最终页面内容（带本地资源路径）
            const threeUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, "node_modules", "three", "build", "three.min.js")));
            const orbitUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, "node_modules", "three", "examples", "jsm", "controls", "OrbitControls.js")));

            panel.webview.html = getGraphWebviewContent(panel.webview, {
                threeUri: threeUri,
                orbitUri: orbitUri,
                data: {
                    nodes: graphData.nodes.map((n) => ({
                        ...n,
                        group: n.group, // 确保group字段存在
                    })),
                    links: graphData.links,
                },
            });

            // 消息处理（添加错误捕获）
            panel.webview.onDidReceiveMessage(
                (message) => {
                    try {
                        if (message.command === "subscribeUpdates") {
                            const disposable = bookmarkProvider.onDidUpdateGraphData(() => {
                                panel.webview.postMessage({
                                    command: "updateData",
                                    data: bookmarkProvider.getGraphData(),
                                });
                            });
                            panel.onDidDispose(() => {
                                disposable.dispose();
                            });
                        }
                    } catch (error) {
                        vscode.window.showErrorMessage(`可视化通信错误: ${error}`);
                    }
                },
                null,
                context.subscriptions
            );
        })
    );

    // 可视化页面生成
    function getGraphWebviewContent(
        webview: vscode.Webview,
        resources: {
            threeUri: vscode.Uri;
            orbitUri: vscode.Uri;
            data: any; // 明确数据结构
        }
    ) {
        const config = vscode.workspace.getConfiguration("bookmark.graphSettings");
        const linkOpacity = config.get<number>("linkOpacity") || 0.3;

        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <style>
        #loading {
            color: var(--vscode-editor-foreground);
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
        }
        canvas {
            width: 100vw !important;
            height: 100vh !important;
            background: var(--vscode-editor-background);
        }
        #debug {
            position: fixed;
            top: 10px;
            left: 10px;
            color: var(--vscode-editor-foreground);
            background: var(--vscode-editorWidget-background);
            padding: 8px;
            border-radius: 4px;
            z-index: 1000;
        }
        #layout-controls {
            position: fixed;
            top: 20px;
            left: 20px;
            background: rgba(30, 30, 30, 0.8);
            padding: 10px;
            border-radius: 5px;
            z-index: 1000;
        }
        .layout-btn {
            display: block;
            margin: 5px 0;
            padding: 6px 12px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
        }
    </style>
    <!-- 添加d3.js -->
    <script src="https://d3js.org/d3.v7.min.js"></script>
    <!-- 使用单一CDN加载Three.js核心库 -->
    <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js"></script>
    <!-- 正确加载OrbitControls -->
    <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
</head>
<body>
    <div id="loading">正在加载可视化引擎...</div>
    <div id="info" style="display: none">按住鼠标拖拽旋转，滚轮缩放</div>
    <div id="layout-controls">
        <button class="layout-btn" onclick="changeLayout('force')">力导布局</button>
        <button class="layout-btn" onclick="changeLayout('circular')">环形布局</button>
        <button class="layout-btn" onclick="changeLayout('grid')">网格布局</button>
        <button class="layout-btn" onclick="changeLayout('hierarchy')">层次布局</button>
    </div>
    <script>
        // 初始化数据
        const graphData = ${JSON.stringify(resources.data)};
        // 添加旋转控制相关变量
        let isRotating = false;
        let currentSpeed = 1;

        // 旋转开关功能
        function toggleRotation() {
            isRotating = !isRotating;
            controls.autoRotate = isRotating;
            controls.autoRotateSpeed = currentSpeed;
            document.getElementById('rotationBtn').innerText = isRotating ? '停止旋转' : '开始旋转';
        }

        // 速度调节功能
        function updateSpeed(value) {
            currentSpeed = parseFloat(value);
            if (isRotating) {
                controls.autoRotateSpeed = currentSpeed;
            }
            document.getElementById('speedValue').innerText = currentSpeed.toFixed(1);
        }

        function initVisualization() {
            // 使用解构语法获取数据
            const { nodes: rawNodes, links: rawLinks } = graphData;
            // 添加空值检查
            if (!rawNodes || !rawLinks) {
                throw new Error('Invalid graph data structure');
            }
            // 处理节点数据
            const nodes = rawNodes.filter(node => {
                const isValid = !!node.id;
                if (!isValid) console.warn('Invalid node:', node);
                return isValid;
            }).map(node => ({
                ...node,
                originalColor: new THREE.Color().setHSL(
                    Math.random(), // 更自然的颜色分布
                    0.7, 
                    0.5
                )
            }));
            // 处理连线数据
            const links = rawLinks.filter(link => {
                const sourceExists = nodes.some(n => n.id === link.source);
                const targetExists = nodes.some(n => n.id === link.target);
                return sourceExists && targetExists;
            });

            let scene, camera, renderer, controls;
            let simulation = null;

            function init() {
                // 场景初始化
                scene = new THREE.Scene();
                scene.background = new THREE.Color(0x1e1e1e);

                // 相机设置
                camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
                camera.position.z = 100;

                // 渲染器设置
                renderer = new THREE.WebGLRenderer({ antialias: true });
                renderer.setSize(window.innerWidth, window.innerHeight);
                document.body.appendChild(renderer.domElement);

                // 控制器初始化（必须在此位置）
                controls = new THREE.OrbitControls(camera, renderer.domElement);
                controls.enableDamping = true;
                controls.dampingFactor = 0.05;
                controls.autoRotate = false;  // 初始关闭自动旋转
                controls.autoRotateSpeed = currentSpeed;  // 设置默认速度

                // 光源设置
                const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
                scene.add(ambientLight);

                const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
                directionalLight.position.set(1, 1, 1).normalize();
                scene.add(directionalLight);

                // 初始化 D3 力导向模拟
                simulation = d3.forceSimulation(nodes)
                    .force("charge", d3.forceManyBody().strength(-30))
                    .force("link", d3.forceLink(links).id(d => d.id))
                    .force("center", d3.forceCenter(0, 0))
                    .alphaDecay(0.05);

                // 同步位置的回调函数
                function syncPositions() {
                    nodes.forEach(node => {
                        node.position.x = node.x;
                        node.position.y = node.y;
                        node.position.z = node.z || 0; // 添加 Z 轴位置
                    });
                }

                simulation.on("tick", syncPositions);

                // 创建节点
                nodes.forEach((node) => {
                    const geometry = new THREE.SphereGeometry(node.size / 8, 32, 32);
                    const material = new THREE.MeshPhongMaterial({
                        color: new THREE.Color().setHSL(node.group.length * 0.01, 0.7, 0.5),
                        transparent: true,
                        opacity: 0.9
                    });
                    const sphere = new THREE.Mesh(geometry, material);
                    sphere.position.set(
                        (Math.random() - 0.5) * 30,
                        (Math.random() - 0.5) * 30,
                        (Math.random() - 0.5) * 30
                    );
                    sphere.userData = node;
                    scene.add(sphere);
                });

                // 创建连线
                links.forEach((link) => {
                    const sourceNode = nodes.find(n => n.userData.id === link.source);
                    const targetNode = nodes.find(n => n.userData.id === link.target);

                    if (sourceNode && targetNode) {
                        const geometry = new THREE.BufferGeometry().setFromPoints([
                            sourceNode.position,
                            targetNode.position
                        ]);
                        const material = new THREE.LineBasicMaterial({
                            color: 0x00ff00,
                            transparent: true,
                            opacity: ${linkOpacity}
                        });
                        const line = new THREE.Line(geometry, material);
                        scene.add(line);
                    }
                });

                // 布局算法集合
                const layoutAlgorithms = {
                    // 原有力导布局
                    force: (nodes, links) => {
                        simulation.force("charge", d3.forceManyBody().strength(-30))
                            .force("link", d3.forceLink(links)
                                .id(d => d.id)
                                .distance(d => d.value * 10))
                            .alphaTarget(0.3)
                            .restart();
                    },
                    // 环形布局
                    circular: (nodes) => {
    const radius = Math.min(window.innerWidth, window.innerHeight) / 3;
    const angleStep = (2 * Math.PI) / nodes.length;
    nodes.forEach((node, i) => {
        const angle = i * angleStep;
        node.x = radius * Math.cos(angle); // 修改为直接设置坐标
        node.y = radius * Math.sin(angle);
        node.z = 0;
    });
    simulation.alpha(1).restart(); // 重新激活模拟器
},
                    // 网格布局
                    grid: (nodes) => {
                        const cols = Math.ceil(Math.sqrt(nodes.length));
                        const spacing = 50;
                        nodes.forEach((node, i) => {
                            const row = Math.floor(i / cols);
                            const col = i % cols;
                            node.position.x = (col - cols / 2) * spacing;
                            node.position.y = (row - cols / 2) * spacing;
                            node.position.z = 0;
                        });
                        simulation.force("charge", null)
                            .force("link", null)
                            .alphaTarget(0.3).restart();
                    },
                    // 层次布局（按文件路径层级）
                    hierarchy: (nodes) => {
                        const depthMap = new Map();
                        nodes.forEach(node => {
                            const depth = node.userData.path.split('/').length;
                            depthMap.set(node, depth);
                        });
                        const maxDepth = Math.max(...depthMap.values());
                        const verticalSpacing = 80;
                        nodes.forEach(node => {
                            const depth = depthMap.get(node);
                            node.position.x = (Math.random() - 0.5) * 100;
                            node.position.y = (maxDepth - depth) * verticalSpacing;
                            node.position.z = (Math.random() - 0.5) * 100;
                        });
                        simulation.force("charge", d3.forceManyBody().strength(-30))
                            .force("y", d3.forceY().strength(0.1))
                            .alphaTarget(0.3).restart();
                    }
                };

                // 添加布局切换函数
                function changeLayout(layoutType) {
                    if (simulation) simulation.stop(); // 停止当前力导模拟
                    layoutAlgorithms[layoutType](nodes, links);
                    syncPositions();  // 新增强制同步位置
                    renderer.render(scene, camera); // 新增立即渲染
                }

                // 初始化时读取配置
                let initialLayout = ${JSON.stringify(vscode.workspace.getConfiguration("bookmark.graphSettings").get("layout"))};
                setTimeout(() => changeLayout(initialLayout), 500);

                // 窗口大小变化监听
                window.addEventListener("resize", onWindowResize);
            }

            function onWindowResize() {
                camera.aspect = window.innerWidth / window.innerHeight;
                camera.updateProjectionMatrix();
                renderer.setSize(window.innerWidth, window.innerHeight);
            }

            function animate() {
    requestAnimationFrame(animate);
    if (isRotating) {
        controls.autoRotate = true;
        controls.update();
        renderer.render(scene, camera);
    }
    renderer.render(scene, camera);
}

            // 启动初始化
            init();
            animate();
        }

        // 启动可视化
        window.addEventListener('load', () => {
            try {
                initVisualization(graphData);
                document.getElementById('loading').style.display = 'none';
                document.getElementById('info').style.display = 'block';
            } catch (error) {
                document.body.innerHTML = \`<p style="color:red">初始化失败：\${error}</p>\`;
            }
        });

        // 在HTML中处理更新
        window.addEventListener('message', event => {
            if (event.data.command === 'updateData') {
                scene.remove(...nodes, ...links);
                initVisualization(event.data.data);
            }
            if (event.data.command === 'changeLayout') {
                changeLayout(event.data.layout);
            }
        });

        // 添加鼠标悬停效果
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();

        function onMouseMove(event) {
            mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
            mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

            raycaster.setFromCamera(mouse, camera);
            const intersects = raycaster.intersectObjects(nodes);

            nodes.forEach(node => {
                node.material.color.setHex(node.userData.originalColor);
            });

            if (intersects.length > 0) {
                intersects[0].object.material.color.set(0xff0000);
                document.body.style.cursor = 'pointer';
            } else {
                document.body.style.cursor = 'default';
            }
        }

        // 添加鼠标移动事件监听
        document.addEventListener('mousemove', onMouseMove);
    </script>
    <div id="controls">
    <button id="rotationBtn" onclick="toggleRotation()">开始旋转</button>
    <div style="color:white; margin-top:5px;">
        速度: 
        <input type="range" id="speed" min="0.5" max="3" step="0.1" value="1" 
               oninput="updateSpeed(this.value)" 
               style="vertical-align: middle;">
        <span id="speedValue" style="margin-left:5px;">1.0</span>
    </div>
    </div>
    <style>
        #controls {
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(30, 30, 30, 0.8);
            padding: 10px;
            border-radius: 5px;
            z-index: 1000;
        }
            /* 增加按钮交互反馈 */
.layout-btn:hover {
    opacity: 0.9;
    transform: scale(1.05);
}

/* 速度调节条样式 */
input[type="range"] {
    width: 120px;
    height: 4px;
    background: var(--vscode-input-background);
}
    </style>
</body>
</html>`;
    }

    // 添加Webview内容生成函数
    function getShareWebviewContent(qrData: string, bookmark: Bookmark): string {
        return `
        <style>
        .expired-warning {
            color: #ff9900;
            border: 1px solid #ff9900;
            padding: 8px;
            border-radius: 4px;
            margin: 10px 0;
            background: #fff9e6;
        }
    </style>
    ${
        bookmark.isExpired
            ? `
    <div class="expired-warning">
        ⚠️ 该书签标记为可能过期状态，扫码前请确认有效性
    </div>
    `
            : ""
    }
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>书签分享</title>
        <style>
            .container {
                padding: 20px;
                text-align: center;
                background: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
            }
            .qr-container {
                margin: 20px auto;
                padding: 10px;
                background: white;
                border-radius: 8px;
                display: inline-block;
            }
            .meta-info {
                margin-top: 15px;
                font-size: 0.9em;
                opacity: 0.8;
            }
            button {
                padding: 8px 16px;
                margin: 5px;
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                border-radius: 4px;
                cursor: pointer;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h3>${bookmark.label}</h3>
            <div class="qr-container">
                <img src="${qrData}" width="300" height="300">
            </div>
            <div class="meta-info">
                <p>文件: ${path.basename(bookmark.filePath)}</p>
                <p>行号: ${bookmark.lineNumber + 1}</p>
            </div>
            <div>
                <button onclick="copyLink()">复制链接</button>
                <button onclick="downloadQR()">保存图片</button>
            </div>
        </div>
        <script>
            function copyLink() {
                const input = document.createElement('input');
                input.value = ${JSON.stringify(qrData)};
                document.body.appendChild(input);
                input.select();
                document.execCommand('copy');
                document.body.removeChild(input);
                vscode.window.showInformationMessage('链接已复制到剪贴板');
            }

            function downloadQR() {
                const link = document.createElement('a');
                link.download = 'bookmark-qr.png';
                link.href = ${JSON.stringify(qrData)};
                link.click();
            }
        </script>
    </body>
    </html>
    `;
    }

    // 返回清理函数
    return {
        async deactivate() {
            // 新增日志通道清理
            bookmarkProvider.logger.dispose();
            // 立即保存书签数据
            await bookmarkProvider.forceSaveBookmarks();
            // 清理文件监听器
            bookmarkProvider.disposeFileWatcher();
        },
    };
}

export function deactivate() {
    // 空函数，实际逻辑在返回的清理函数中
}
