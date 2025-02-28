import * as assert from "assert";
import * as vscode from "vscode";
import { activate } from "../extension";
import { BookmarkManager } from "../bookmarkManager";
import type { Bookmark } from "../bookmarkManager"; // 新增类型导入

// 测试超时设置为5秒
const TEST_TIMEOUT = 5000;

suite("书签扩展测试套件", () => {
    let extension: vscode.Extension<any>;
    let bookmarkManager: BookmarkManager;
    let testDocument: vscode.TextDocument;

    suiteSetup(async () => {
        // 激活扩展
        const context = await vscode.extensions.getExtension("Vogadero.bookmark")?.activate();
        if (!context) {
            throw new Error("扩展激活失败");
        }

        // 初始化测试文档
        testDocument = await vscode.workspace.openTextDocument({
            content: 'function test() {\n  console.log("bookmark test");\n}',
        });
        await vscode.window.showTextDocument(testDocument);
    });

    setup(async () => {
        // 每个测试前重置书签管理器
        bookmarkManager = BookmarkManager.getInstance();
        await bookmarkManager.clearAllBookmarks();
    });

    test("应正确添加书签", async () => {
        const testLine = 0;

        // 执行添加命令
        await vscode.commands.executeCommand("bookmark.add", testDocument.uri, testLine);

        const bookmarks = bookmarkManager.getBookmarks();
        assert.strictEqual(bookmarks.length, 1, "书签数量不符");
        assert.strictEqual(bookmarks[0].lineNumber, testLine, "书签行号错误");
        assert.strictEqual(
            bookmarkManager.getAbsolutePath(bookmarks[0]), // 使用管理器提供的路径转换方法
            testDocument.uri.fsPath,
            "文档路径不符"
        );
    }).timeout(TEST_TIMEOUT);

    test("应正确处理路径转换", async () => {
        const testUri = testDocument.uri;
        const relativePath = bookmarkManager.testPathConversion(testUri);

        assert.strictEqual(
            bookmarkManager.getAbsolutePath({
                filePath: relativePath,
                workspaceFolder: vscode.workspace.getWorkspaceFolder(testUri)?.uri.fsPath,
            } as Bookmark),
            testUri.fsPath,
            "路径转换逻辑错误"
        );
    }).timeout(TEST_TIMEOUT);

    test("应正确删除书签", async () => {
        // 先添加两个书签
        await vscode.commands.executeCommand("bookmark.add", testDocument.uri, 0);
        await vscode.commands.executeCommand("bookmark.add", testDocument.uri, 1);

        // 删除第二个书签
        await vscode.commands.executeCommand("bookmark.remove", testDocument.uri, 1);

        const bookmarks = bookmarkManager.getBookmarks();
        assert.strictEqual(bookmarks.length, 1, "删除后书签数量错误");
        assert.strictEqual(bookmarks[0].lineNumber, 0, "剩余书签行号错误");
    }).timeout(TEST_TIMEOUT);

    test("应正确导航书签", async () => {
        // 添加三个书签
        await vscode.commands.executeCommand("bookmark.add", testDocument.uri, 0);
        await vscode.commands.executeCommand("bookmark.add", testDocument.uri, 1);
        await vscode.commands.executeCommand("bookmark.add", testDocument.uri, 2);

        // 测试下一个导航
        let pos = await bookmarkManager.jumpToNext();
        assert.strictEqual(pos?.line, 0, "初始位置错误");

        pos = await bookmarkManager.jumpToNext();
        assert.strictEqual(pos?.line, 1, "第一次跳转错误");

        // 测试上一个导航
        pos = await bookmarkManager.jumpToPrevious();
        assert.strictEqual(pos?.line, 0, "回跳错误");
    }).timeout(TEST_TIMEOUT);

    test("应正确处理无书签情况", async () => {
        await bookmarkManager.clearAllBookmarks();

        try {
            await bookmarkManager.jumpToNext();
            assert.fail("应抛出无书签错误");
        } catch (err) {
            // 添加类型检查
            assert.ok(err instanceof Error, "错误类型不符");
            assert.match(
                (err as Error).message, // 使用类型断言
                /没有可用的书签/,
                "错误信息不符"
            );
        }
    }).timeout(TEST_TIMEOUT);

    test("应正确清除所有书签", async () => {
        // 添加测试数据
        await vscode.commands.executeCommand("bookmark.add", testDocument.uri, 0);
        await vscode.commands.executeCommand("bookmark.add", testDocument.uri, 1);

        // 执行清除
        await vscode.commands.executeCommand("bookmark.clearAll");

        assert.strictEqual(bookmarkManager.getBookmarks().length, 0, "清除后应无书签");
    }).timeout(TEST_TIMEOUT);
});
