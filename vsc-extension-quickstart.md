#### 欢迎使用 VS Code 扩展开发指南

## 文件结构概述

此文件夹包含扩展所需的所有文件：

- **`package.json`**：这是扩展的清单文件，用于声明扩展及其命令。
  - 示例插件注册了一个命令，并定义了其标题和命令名称。VS Code 可以根据这些信息在命令面板中显示该命令，而无需加载插件。
  
- **`src/extension.ts`**：这是扩展的主要实现文件。
  - 文件导出一个函数 `activate`，当扩展首次激活时（例如通过执行命令）调用此函数。在 `activate` 函数内部，我们调用 `registerCommand` 并传递包含命令实现的函数作为第二个参数。

## 环境设置

安装推荐的扩展：
- [amodio.tsl-problem-matcher](https://marketplace.visualstudio.com/items?itemName=amodio.tsl-problem-matcher)
- [ms-vscode.extension-test-runner](https://marketplace.visualstudio.com/items?itemName=ms-vscode.extension-test-runner)
- [dbaeumer.vscode-eslint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)

## 快速上手

1. **启动扩展调试窗口**：
   - 按 `F5` 打开一个新窗口，加载你的扩展。
   
2. **运行命令**：
   - 按 `Ctrl+Shift+P`（Windows/Linux）或 `Cmd+Shift+P`（Mac），输入并选择命令（如 `Hello World`）。
   
3. **调试扩展**：
   - 在 `src/extension.ts` 中设置断点，通过调试工具栏重新启动扩展，或按 `Ctrl+R`（Windows/Linux）或 `Cmd+R`（Mac）重新加载 VS Code 窗口以应用更改。

4. **查看输出**：
   - 在调试控制台中查找扩展的输出信息。

## 探索 API

- 打开 `node_modules/@types/vscode/index.d.ts` 文件，可以浏览完整的 VS Code API。

## 运行测试

1. **安装测试运行器**：
   - 安装 [Extension Test Runner](https://marketplace.visualstudio.com/items?itemName=ms-vscode.extension-test-runner)。
   
2. **运行任务**：
   - 通过 **Tasks: Run Task** 命令运行 "watch" 任务，确保它正在运行，否则测试可能无法被发现。
   
3. **运行测试**：
   - 从左侧活动栏打开测试视图，点击“Run Test”按钮，或使用快捷键 `Ctrl/Cmd + ; A`。
   
4. **查看测试结果**：
   - 在测试结果视图中查看测试输出。
   
5. **编写测试**：
   - 修改 `src/test/extension.test.ts` 或在 `test` 文件夹内创建新的测试文件。测试文件应匹配 `**.test.ts` 模式。

## 进一步优化

- **打包扩展**：通过[打包扩展](https://code.visualstudio.com/api/working-with-extensions/bundling-extension)减少扩展大小并提高启动速度。
- **发布扩展**：将扩展发布到 [VS Code 扩展市场](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)。
- **持续集成**：设置[持续集成](https://code.visualstudio.com/api/working-with-extensions/continuous-integration)以自动化构建过程。
