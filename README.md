# 西游数字分身 · 公众网页端

静态前端加同源 Node.js 云端代理。访客使用手机或电脑浏览器即可访问，不需要填写 API Key，密钥只存在部署平台的环境变量中。

## 本地运行

需要 Node.js 20 或更高版本，无第三方依赖。

```bash
npm start
```

访问 `http://localhost:3000`。不要通过 `file://` 验证正式云端代理；该方式只用于界面预览。

## 公开部署

把整个目录部署到支持 Node.js 20+ 的 Render、Railway 等平台：

- 构建命令：`npm install`
- 启动命令：`npm start`
- 环境变量：按 `.env.example` 配置。使用平台端口时保留其自动注入的 `PORT`。
- 正式网站必须启用 HTTPS。平台有可信反向代理时将 `TRUST_PROXY` 设为 `1`。

无 `CLOUD_API_KEY` 时默认使用免费开源模型 GPT-OSS 20B（Pollinations 公共接口），无需配置 Key 即可上线。该免费接口按 IP 限流，部署后由服务端代理集中承载访客流量，实际限流压力来自服务器 IP；若访客量大，可换成其他开源模型服务（如 Groq 托管的 Llama、自建 vLLM + WebLLM 前端），只需修改 `CLOUD_API_URL` / `CLOUD_MODEL` / `CLOUD_API_KEY` 三个环境变量，前端无需改动。不要将 Key 写入 `app.js`、`index.html` 或提交到仓库。

## 访问与成本控制

- 单 IP 每 10 分钟最多 20 次请求，全站同时最多 8 个上游请求。
- 限制消息条数、单条长度与总长度；上游请求最长 100 秒。
- 只公开四个前端文件，不公开 `.env`、服务端源码和配置文件。
- 正式运营应在平台层补充 CDN/WAF、持久化限流、用量告警和预算上限；单机内存限流不能替代多实例共享限流。

## 检查

```bash
npm run check
npm test
```

健康检查：`GET /api/health`。
