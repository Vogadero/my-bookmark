# 贡献指南

## 开发环境
- Node.js v18+
- VS Code Extension Toolkit
- TypeScript 5.0+

## 代码规范
1. 使用 Airbnb JavaScript 规范
2. 所有导出函数必须包含 JSDoc
3. 重要逻辑必须包含单元测试

## 提交规范
- `feat`: 新功能
- `fix`: Bug修复
- `docs`: 文档更新
- `style`: 代码格式化
- `refactor`: 代码重构
- `test`: 测试相关
- `chore`: 构建/依赖更新

## 翻译流程
1. 在 `package.json` 中新增语言配置
2. 创建对应的 nls 文件
3. 更新语言切换逻辑
4. 提交时附带截图验证

## 测试要求
- 核心功能测试覆盖率 ≥80%
- 新增代码必须包含测试用例
- 使用 `npm test` 验证所有测试