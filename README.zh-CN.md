# llm-systems-lab 中文快速开始

[English](README.md)

## 快速开始与支持状态

### 问题
把小型 LLM 推理系统的数值正确性变成可执行证据，覆盖全前缀解码、增量 KV 缓存、故障注入和逻辑分页记账。

### 安装
```sh
npm install
```

### 成功命令
```sh
npm run build && node dist/src/cli.js demo
```
预期：正常路径通过，每种注入分歧都在 position 1 被抓到；退出码 0。

### 故意失败命令
```sh
npm run build && node dist/src/cli.js run --seed 7 --tokens 1,4,2,8,3,9 --fault cache-overwrite
```
预期：报告指出 position 1 发生分歧；退出码 1。

### 证据与覆盖边界
<!-- verification-evidence:start -->
证据包括 231/231 项 TypeScript 测试及 130 个独立 NumPy fixture 用例、23/23 项 Web 测试、18/18 项 Python 测试、11/11 个变异体、20/20 个浏览器 E2E 场景，以及 scripts/verify.mjs 八阶段总验收。这些是冻结的小型解码器契约的回归与集成证据，不是对所有输入的证明，也不是模型质量测量。
<!-- verification-evidence:end -->

### 支持状态
当前版本 0.1.0-a1 是 A3 公开测试版。支持环境：Node.js >= 22.18.0；仅在运行参考测试时需要 Python 3 与 NumPy；浏览器 E2E 需要本机 Edge 或 Chrome。维护为尽力而为，不提供 SLA 或生产支持承诺。

### 限制
权重未训练；分页是逻辑字节记账而非实测显存；浏览器证据来自 Windows 上的 headless Edge；页面耗时是 JavaScript 计算时间；130 个用例是回归证据而非通用正确性证明。1.0 之前 CLI 与导出接口可能变化。
