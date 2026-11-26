# Mock 服务

需要 Node.js 20 或更高版本。服务只使用 Node.js 内置模块。

## 启动

在仓库根目录执行 `npm start`。默认端口为 `3000`。

```sh
curl -fsS http://127.0.0.1:3000/health
```

`GET /health` 返回 HTTP 200 和 `{"status":"ok"}`。按 `Ctrl+C` 或向服务进程发送 `SIGTERM` 可关闭服务。

## 配置

```sh
PORT=8080 DEFAULT_TIMEOUT_MS=3000 npm start
```

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口，范围为 `0`–`65535`。设置为 `0` 时由系统分配端口，实际端口见启动日志。 |
| `DEFAULT_TIMEOUT_MS` | `5000` | HTTP 请求接收和连接空闲超时，单位为毫秒。 |

## 测试

```sh
npm test
```
