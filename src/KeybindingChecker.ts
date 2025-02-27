import * as vscode from "vscode";

export class KeybindingChecker {
    private context: vscode.ExtensionContext;
    private extensionKeybindings: string[] = [];

    // 初始化需要检测的快捷键列表
    constructor(context: vscode.ExtensionContext) {
        this.context = context; // 保存context到实例
        const packageJSON = context.extension.packageJSON;
        this.extensionKeybindings = packageJSON.contributes?.keybindings?.map((kb: any) => `${kb.key}@${kb.when || ""}`) || [];
    }

    // 检测冲突的核心方法
    public async checkConflicts() {
        const allKeybindings = await vscode.commands.getCommands(true);
        const conflicts: string[] = [];

        for (const kb of this.extensionKeybindings) {
            const [key, when] = kb.split("@");
            const keybindingsConfig = vscode.workspace.getConfiguration("keybindings").get("keybindings") as Array<{ command: string; key: string; when?: string }> | undefined;

            const conflict = allKeybindings.find((cmd) => {
                const binding = keybindingsConfig?.find((k) => k.command === cmd && k.key === key && k.when === when);
                return binding && !cmd.startsWith("bookmark.");
            });

            if (conflict) {
                conflicts.push(`⚠️ 快捷键冲突: ${key} (被 ${conflict} 占用)`);
            }
        }

        return conflicts;
    }

    // 显示冲突提示
    public async showConflictNotification() {
        const conflicts = await this.checkConflicts();
        if (conflicts.length > 0) {
            vscode.window
                .showWarningMessage(
                    "书签扩展检测到快捷键冲突",
                    "自动修复", // 新增修复按钮
                    "查看详情",
                    "忽略"
                )
                .then(async (choice) => {
                    if (choice === "自动修复") {
                        const fixed = await this.fixConflicts();
                        vscode.window.showInformationMessage(`已自动修复 ${fixed} 个快捷键冲突，需要重载窗口生效`);
                    } else if (choice === "查看详情") {
                        this.showConflictPanel(conflicts);
                    }
                });
        }
    }

    // 新增修复方法
    public async fixConflicts() {
        const config = vscode.workspace.getConfiguration("keybindings");
        const keybindings: Array<{ command: string; key: string; when?: string }> = config.get("keybindings") || [];

        const ourKeybindings = keybindings.filter((k) => k.command.startsWith("bookmark."));

        // 生成替代键位映射表
        const keyMapping: { [original: string]: string } = {
            "ctrl+f1": "ctrl+shift+f1",
            "alt+f1": "alt+shift+f1",
            f1: "shift+f1",
        };

        let fixedCount = 0;

        // 修改冲突的快捷键
        const newKeybindings = keybindings.map((binding) => {
            const conflict = ourKeybindings.find((our) => our.key === binding.key && our.when === binding.when && !binding.command.startsWith("bookmark."));

            if (conflict) {
                fixedCount++;
                return {
                    ...binding,
                    key: keyMapping[binding.key.toLowerCase()] || `${binding.key}+bookmark`, // 自动生成新键位
                };
            }
            return binding;
        });

        await config.update("keybindings", newKeybindings, true);
        return fixedCount;
    }

    // 显示冲突面板
    private showConflictPanel(conflicts: string[]) {
        const panel = vscode.window.createWebviewPanel("bookmarkConflicts", "快捷键冲突报告", vscode.ViewColumn.Active, {});

        panel.webview.html = `<!DOCTYPE html>
        <html>
        <body>
        
            <h2>检测到 ${conflicts.length} 个快捷键冲突：</h2>
            <ul>${conflicts.map((c) => `<li>${c}</li>`).join("")}</ul>
            <p>解决方法：</p>
            <ol>
                <li>打开快捷键设置 (Ctrl+K Ctrl+S)</li>
                <li>搜索冲突快捷键</li>
                <li>右键选择"更改键绑定"</li>
            </ol>
            <div style="margin-top: 20px;">
                <button onclick="fixConflicts()" style="padding: 8px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer;">
                    一键自动修复
                </button>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                function fixConflicts() {
                    vscode.postMessage({ command: 'fixConflicts' });
                }
            </script>
        </body>
        </html>`;

        // 新增消息监听
        panel.webview.onDidReceiveMessage(
            async (message) => {
                if (message.command === "fixConflicts") {
                    const fixed = await this.fixConflicts();
                    panel.webview.html = `<!DOCTYPE html>
                <html><body>
                    <h2>✅ 已自动修复 ${fixed} 个冲突</h2>
                    <p>需要重载窗口使修改生效</p>
                </body></html>`;
                }
            },
            undefined,
            this.context.subscriptions
        );
    }
}
