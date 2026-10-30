# Intent Bus Test Lab

真实 Intent Bus 的人机测试页：运行场景、查看消息轨迹、注入故障、导出证据。

- 在线地址：https://quaketechstone.github.io/Intent_forge/
- SDK 版本：`0.4.0`
- 总线提交：`c87dbaa`
- 产物构建：`2026-10-30T19:17:01Z`

## 这个页面测什么

页面加载的是**真实总线**（`runtime/bus/` 内联的浏览器 bundle，由总线源码转译而来，不是 mock），
通过正式 SDK 接入；场景执行、审计轨迹、故障注入都是真实调用。

五态结果原样保留，不合并、不美化：

```
17 total · 14 pass · 0 fail · 1 skip · 1 unverified · 1 contract-pending
```

- `skip`：G-1（`manifest.bus` 待批）
- `unverified`：观察者无订阅授权，载荷不可观测
- `contract-pending`：重复 reply / 版本不匹配，公开 API 无注入入口

## 边界（必须读）

- 本页面验证的是**总线与测试 SDK**，不代表任何驱动的生产安全认证。
- 总线**融合准入仍为 BLOCKED**：G-1 `manifest.bus` 未获批、G-2 存储契约未签认、
  G-3 生产适配器未实现、G-5 字段回滚未演练。
- 页面上的 `pass` 只表示该场景的断言在真实总线上成立，不等于"可上线"。

## 目录

```
index.html          页面入口（含部署版本条）
lab.css             样式
runtime/lab/        页面逻辑（含真实驱动面板）
runtime/src/        SDK 转译产物
runtime/fixtures/   场景与样例
runtime/bus/        真实总线浏览器 bundle
runtime/real-driver/ 真实驱动包（锻造器交付，经 SDK 接入）
VERSION.json        版本 / 总线提交 / 构建时间
```

## 本地预览

纯静态，任意静态服务器即可（相对路径，无构建）：

```bash
python3 -m http.server 8000
# 打开 http://127.0.0.1:8000/
```

## 更新方式

本仓库**只托管构建产物**，不含源码。源码在私有仓库维护，由构建脚本
`deploy-pages.mjs` 生成自包含产物后推送。手工改动本仓库的文件会在下次发布时被覆盖。

## 部署

GitHub Pages 使用 **Deploy from a branch**：分支 `main`、目录 `/ (root)`。
根目录的 `.nojekyll` 让 Pages 原样发布文件，不经过 Jekyll 处理（否则 `runtime/` 下的
部分路径会被改写）。

`main` 每次 push 后由 GitHub 自动重建，通常 30–60 秒生效。
