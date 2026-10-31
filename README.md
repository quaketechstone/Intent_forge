# Intent Bus Test Lab（intent-bus-test-sdk）

真实 Intent Bus 的人机测试页：运行场景、查看消息轨迹、注入故障、导出证据。

- 总线提交：`df2d8f4`
- SDK 版本：`0.4.0`
- 构建时间：`2026-10-31T07:06:14.294Z`

## 边界

- 本页面验证的是**总线与测试 SDK**，不代表驱动生产安全认证，也不代表总线融合准入。
- 融合准入仍为 **BLOCKED**（G-1 manifest.bus 未获批、G-2 存储契约未签认、
  G-3 生产适配器未实现、G-5 字段回滚未演练）。
- 场景中的 skip / unverified / contract-pending 均如实保留，未伪装为通过。