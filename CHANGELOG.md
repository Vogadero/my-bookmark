# Changelog

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，本文件记录所有 notable changes。

## [Unreleased]
### Added
- (新功能开发中...)

### Changed
- (代码优化项...)

### Fixed 
- (已修复问题...)

## [1.0.0] - 2024-02-28
### Added
- ✨ 新增核心书签功能：
  - 通过 `Ctrl+Alt+K` 快捷键添加行书签
  - 支持在活动栏查看书签树
  - 提供书签跳转导航功能（`Ctrl+Alt+N/P`）
- 🎨 新增可视化关系图功能（通过 `bookmark.showGraph` 命令触发）
- 🌐 支持书签的导入/导出功能（JSON/Markdown 格式）

### Changed
- ⚡ 优化书签高亮渲染性能
- ♻️ 重构书签存储模块，采用 workspace 隔离模式

### Fixed
- 🐛 修复文件路径变更后书签丢失的问题
- 🐞 修正 Windows 系统下快捷键冲突问题

### Deprecated
- ⚠️ 移除旧版本地存储方案（v0.x 用户需手动迁移数据）



[Unreleased]: https://github.com/Vogadero/my-bookmark/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Vogadero/my-bookmark/releases/tag/v1.0.0