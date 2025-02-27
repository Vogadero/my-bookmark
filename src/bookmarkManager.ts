// src/bookmarkManager.ts
import * as vscode from "vscode";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import { Mutex } from "async-mutex";

export interface Bookmark {
    id: string;
    filePath: string;
    workspaceFolder?: string;
    lineNumber: number;
    label?: string;
    codeHash?: string;
    accessCount: number;
    lastAccessed?: number;
    isExpired?: boolean;
}

export class BookmarkManager {
    private static instance: BookmarkManager;
    private bookmarks: Bookmark[] = [];
    private currentIndex = -1;
    private storageMutex = new Mutex();

    private constructor() {}

    public static getInstance(): BookmarkManager {
        if (!BookmarkManager.instance) {
            BookmarkManager.instance = new BookmarkManager();
        }
        return BookmarkManager.instance;
    }

    // 核心书签操作 ==============================================
    public addBookmark(uri: vscode.Uri, lineNumber: number): Bookmark {
        const workspace = vscode.workspace.getWorkspaceFolder(uri);
        const newBookmark: Bookmark = {
            id: uuidv4(),
            filePath: this.getRelativePath(uri),
            workspaceFolder: workspace?.uri.fsPath,
            lineNumber,
            label: `Bookmark ${this.bookmarks.length + 1}`,
            accessCount: 0,
            codeHash: this.getLineHash(uri, lineNumber),
        };

        this.bookmarks.push(newBookmark);
        return newBookmark;
    }

    public removeBookmark(id: string): void {
        this.bookmarks = this.bookmarks.filter((b) => b.id !== id);
        this.currentIndex = Math.min(this.currentIndex, this.bookmarks.length - 1);
    }

    public clearAllBookmarks(): void {
        this.bookmarks = [];
        this.currentIndex = -1;
    }

    public getBookmarks(): Bookmark[] {
        return [...this.bookmarks];
    }

    // 导航逻辑 ==================================================
    public jumpToNext(): vscode.Position | undefined {
        if (this.bookmarks.length === 0) return undefined;

        this.currentIndex = (this.currentIndex + 1) % this.bookmarks.length;
        return this.getCurrentPosition();
    }

    public jumpToPrevious(): vscode.Position | undefined {
        if (this.bookmarks.length === 0) return undefined;

        this.currentIndex = (this.currentIndex - 1 + this.bookmarks.length) % this.bookmarks.length;
        return this.getCurrentPosition();
    }

    private getCurrentPosition(): vscode.Position | undefined {
        const bookmark = this.bookmarks[this.currentIndex];
        if (!bookmark) return undefined;

        this.recordAccess(bookmark.id);
        return new vscode.Position(bookmark.lineNumber, 0);
    }

    // 工具方法 ==================================================
    private getRelativePath(uri: vscode.Uri): string {
        const workspace = vscode.workspace.getWorkspaceFolder(uri);
        return workspace ? path.relative(workspace.uri.fsPath, uri.fsPath) : uri.fsPath;
    }

    public getAbsolutePath(bookmark: Bookmark): string {
        return bookmark.workspaceFolder ? path.join(bookmark.workspaceFolder, bookmark.filePath) : bookmark.filePath;
    }

    private getLineHash(uri: vscode.Uri, lineNumber: number): string {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        if (!doc) return "";

        const line = doc.lineAt(lineNumber);
        const hash = require("crypto").createHash("sha1");
        return hash.update(line.text).digest("hex").substr(0, 8);
    }

    public recordAccess(id: string): void {
        const bookmark = this.bookmarks.find((b) => b.id === id);
        if (bookmark) {
            bookmark.accessCount = (bookmark.accessCount || 0) + 1;
            bookmark.lastAccessed = Date.now();
        }
    }

    // 持久化相关 ================================================
    public async loadBookmarks(context: vscode.ExtensionContext): Promise<void> {
        const release = await this.storageMutex.acquire();
        try {
            const stored = context.globalState.get<string>("bookmarks");
            if (stored) {
                this.bookmarks = JSON.parse(stored);
            }
        } finally {
            release();
        }
    }

    public async saveBookmarks(context: vscode.ExtensionContext): Promise<void> {
        const release = await this.storageMutex.acquire();
        try {
            await context.globalState.update("bookmarks", JSON.stringify(this.bookmarks));
        } finally {
            release();
        }
    }
}
