# 聚合 AI Studio 与 Gemini 网页版

设置进程环境变量 `ANTIGRAVITY_UPSTREAMS_CONFIG` 指向本机 JSON 文件后，可将原代理入口与支持 OpenAI／Anthropic／Gemini 协议的其他服务聚合。未设置时，专用账户实例保持原接入方式。

```json
[
  {"name":"aistudio","url":"http://127.0.0.1:2048","default":true,"modelStyle":"studio"},
  {"name":"gemini-web","url":"http://127.0.0.1:8007","default":true,"modelStyle":"studio"}
]
```

如后端启用了 API 密钥，在该项填写 `apiKey`，配置文件应仅部署用户可读，不提交真实凭据。

- `/v1/models` 合并原 Antigravity 与外部目录，并额外列出 `aistudio/<模型>`、`gemini-web/<模型>`；使用 `antigravity/<模型>` 可明确走原生反重力通道。响应头 `x-model-source` 表示实际来源。
- 未加来源前缀时，按配置顺序选择明确提供该模型的外部服务。`gemini-4-hydrogen-high` 与 `gemini-4-hydrogen(high)` 自动对应各通道的思考后缀。
- Anthropic Messages 在外部通道不可用时回退原反重力处理器；Claude 型号仍由原处理器接入。OpenAI／Gemini 请求仅在实现同一协议的外部服务之间回退，不声称原反重力实例实现了它没有的协议。
- HTTP容量错误、输出前的SSE容量错误以及纯空Anthropic回复可回退。一旦已开始输出正文、思考正文或工具调用，就转发后续错误，不跨通道重放。客户端断开时取消对应上游请求。
- 账户先后顺序由各后端的账户池控制；可分别配置 `fill-first`，不要把多来源回退当作请求轮询。

对无法回放大量旧工具帧的兼容服务，可选 `historyToolBatches: 2`：较早的工具调用与结果完整转录为历史文本，最近两个批次以及当前交互保持原生结构；只改变该通道的请求视图。战国原生Gemini SDK走 `/v1beta`，不使用这项Anthropic历史兼容处理。

`node --test tests/test-upstreams.js tests/test-account-model-access.cjs` 在本地模拟后端验证选号、回退、签名帧、UTF-8边界和客户端取消，不调用Google。
