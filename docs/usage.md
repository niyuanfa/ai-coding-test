# Mock 服务本地运行

需要 Node.js 22.13 或更新版本，使用内置 SQLite，无需安装 npm 依赖。以下命令从仓库根目录运行。启动时先分配命名空间，凭据用环境变量注入。示例在两个终端中执行，第二个终端需要 `curl` 和 `jq`。

```sh
export MOCK_NAMESPACES='["qa"]'
export MOCK_TOKENS='[{"token":"local-admin","subject":"dev-admin","grants":{"qa":["admin"]}},{"token":"local-client","subject":"dev-client","grants":{"qa":["invoke"]}}]'
export MOCK_DB="$(mktemp -d)/mock.sqlite"
node src/server.cjs
```

默认监听 `127.0.0.1:3000`，可通过 `HOST` 和 `PORT` 调整。用同一个 `MOCK_DB` 重启服务可保留规则、版本、审计历史和未过期的幂等结果。上述令牌用于本地示例。共享环境通过 TLS 接入并注入独立的高熵令牌。管理角色 `admin` 可读写，`observer` 可读，调用角色 `invoke` 只可调用。每个权限授予指定命名空间，同一令牌的管理和调用权限互斥。

## 创建并启用三个场景

在第二个终端执行。函数通过创建响应中的规则 ID 与 ETag 启用版本 1，幂等键按主体和命名空间保存 24 小时。重新走查同一生命周期时使用新的数据库，或为各场景分配新幂等键并先撤下占用相同匹配槽的规则。

```sh
export MOCK_URL=http://127.0.0.1:3000
rules="$MOCK_URL/api/v1/namespaces/qa/rules"
admin='Authorization: Bearer local-admin'
client='Authorization: Bearer local-client'

create_and_enable() {
  created=$(curl -fsS "$rules" -H "$admin" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $1" --data "$2") || return
  id=$(printf '%s' "$created" | jq -er '.id') || return
  revision=$(printf '%s' "$created" | jq -er '.revision') || return
  curl -fsS -X PUT "$rules/$id/state" -H "$admin" -H 'Content-Type: application/json' \
    -H "If-Match: \"$revision\"" --data '{"state":"enabled","version":1}'
}

order=$(create_and_enable order-42 '{"name":"订单 42","match":{"method":"GET","path":"/orders/42","query":{"include":"items"}},"response":{"status":200,"body":{"id":42,"items":[{"sku":"A1"}]}}}')
create_and_enable card-payment '{"name":"信用卡拒付","match":{"method":"POST","path":"/payments","headers":{"X-Client":"checkout"},"jsonBody":{"/channel":"card"}},"response":{"status":422,"body":{"code":"CARD_DECLINED"}},"priority":10}'
create_and_enable inventory-a1 '{"name":"库存暂不可用","match":{"method":"GET","path":"/inventory/A1"},"response":{"status":503,"headers":{"Retry-After":"2"},"body":{"code":"INVENTORY_UNAVAILABLE"},"delayMs":250}}'

# 200，{"id":42,"items":[{"sku":"A1"}]}
curl -si -H "$client" "$MOCK_URL/mock/qa/orders/42?include=items"
# 422，{"code":"CARD_DECLINED"}
curl -si -H "$client" -H 'X-Client: checkout' -H 'Content-Type: application/json' \
  --data '{"channel":"card","amount":100}' "$MOCK_URL/mock/qa/payments"
# 延迟 250 ms，503，Retry-After: 2，{"code":"INVENTORY_UNAVAILABLE"}
curl -si -H "$client" "$MOCK_URL/mock/qa/inventory/A1"
```

## 版本切换和停用

```sh
id=$(printf '%s' "$order" | jq -er '.id')
rule="$rules/$id"
json_header='Content-Type: application/json'

# 保存版本 2，响应 ETag 为 "3"，调用继续返回 A1。
curl -si -X PUT "$rule" -H "$admin" -H "$json_header" -H 'If-Match: "2"' \
  --data '{"match":{"method":"GET","path":"/orders/42","query":{"include":"items"}},"response":{"status":200,"body":{"id":42,"items":[{"sku":"B2"}]}}}'
curl -si -H "$admin" "$rule/versions/2"
# 切到版本 2，响应 ETag 为 "4"，调用返回 B2。
curl -si -X PUT "$rule/state" -H "$admin" -H "$json_header" -H 'If-Match: "3"' \
  --data '{"state":"enabled","version":2}'
curl -si -H "$client" "$MOCK_URL/mock/qa/orders/42?include=items"
# 停用，响应 ETag 为 "5"，调用返回 404 MOCK_RULE_NOT_FOUND。
curl -si -X PUT "$rule/state" -H "$admin" -H "$json_header" -H 'If-Match: "4"' \
  --data '{"state":"disabled"}'
curl -si -H "$client" "$MOCK_URL/mock/qa/orders/42?include=items"
# 删除，响应 204，详情和版本接口返回 404 RULE_NOT_FOUND。
curl -si -X DELETE "$rule" -H "$admin" -H 'If-Match: "5"'
```

使用带当前 ETag 的 `PUT /{id}/state`，提交 `{"state":"enabled","version":1}` 即可切回版本 1。`GET /{id}/versions` 按版本号降序列出版本。已经选中版本的请求会使用该版本完成。`GET /rules?name=名称&state=enabled` 支持两个可独立使用的精确筛选条件。`description` 可在创建或保存版本时指定，更新时省略会继承上一版本的描述。详情中的描述来自最近保存版本。创建时间和最近变更时间以 UTC ISO 8601 表示。

## 匹配和响应

方法和原始路径精确匹配，`HEAD` 使用独立规则。配置的查询键必须恰好出现一次，参数以 UTF-8 解码，`+` 表示空格。请求头名忽略大小写，值去掉首尾空格和制表符后匹配，重复值按接收顺序用 `, ` 合并。`jsonBody` 使用 RFC 6901 指针与 JSON 标量，字段缺失和 `null` 不同。无效或缺失 JSON 只会跳过依赖请求体的候选。所有配置的条件需同时满足。较大的 `priority` 优先，同命名空间、方法、路径和优先级仅允许一个启用版本。

响应状态码支持 200–599，延迟上限 5000 ms。`response.format` 默认为 `json`，按 UTF-8 JSON 序列化 `body`。指定 `"format":"text"` 时，字符串响应体按原文发送，默认媒体类型为 `text/plain; charset=utf-8`。省略 `body` 发送空响应，JSON 格式的 `null` 发送 JSON `null`。`HEAD`、204、205 和 304 只发送空响应体。`X-Request-Id` 由系统生成，响应配置禁止覆盖。管理 JSON 和参与匹配的 JSON 请求体上限为 1 MiB。若延迟请求由客户端或代理提前中断，检查其超时是否覆盖配置延迟与网络耗时。

以下示例指定规则 ID 和纯文本响应。`id` 只在创建时可指定，允许 1–128 个 ASCII 字母、数字、下划线或连字符，省略时由服务端生成。显式 ID 全局唯一，软删除后仍保留。

```sh
create_and_enable greeting-create '{"id":"greeting","name":"纯文本问候","match":{"method":"GET","path":"/greeting"},"response":{"status":200,"format":"text","body":"你好"}}'
# 200，Content-Type: text/plain; charset=utf-8，响应体为 你好
curl -si -H "$client" "$MOCK_URL/mock/qa/greeting"
```

## 错误和排查

系统错误采用 `{"error":{"code":"…","message":"…"}}`，配置字段错误附带 `fields`，冲突附带 `conflictingRuleId`。业务模拟错误使用规则配置。通过响应的 `X-Request-Id` 查询 JSON 日志，调用日志记录结果、状态码、候选数及选中规则和版本。管理变更日志记录操作、规则和修订号。日志只写入这些诊断字段。

| HTTP | 错误码 | 排查 |
| --- | --- | --- |
| 400 | `INVALID_CONFIG` | 检查 `error.fields`、JSON 类型、重复键及字段取值。 |
| 400 | `INVALID_REQUEST` | 检查路径和查询参数编码或请求体读取是否中断。 |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | 带上非空 `Idempotency-Key`。 |
| 401 | `UNAUTHENTICATED` | 检查 Bearer 凭据。 |
| 403 | `FORBIDDEN` | 检查接口角色和命名空间授权。 |
| 404 | `MOCK_RULE_NOT_FOUND` | 检查规则状态、生效版本及完整匹配条件。 |
| 404 | `RULE_NOT_FOUND`、`VERSION_NOT_FOUND`、`ROUTE_NOT_FOUND` | 检查 ID、版本号和接口路径。 |
| 409 | `RULE_CONFLICT` | 查冲突规则，调整优先级或停用占用者。 |
| 409 | `DUPLICATE_RULE_ID` | 创建时指定未使用的 ID 或省略 ID。 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 新建请求使用新键，重试使用原始 JSON。 |
| 412 | `REVISION_MISMATCH` | 重新查询当前 ETag。 |
| 413 | `REQUEST_TOO_LARGE` | 缩小请求体。 |
| 428 | `PRECONDITION_REQUIRED` | 带上最新 `If-Match`。 |
| 500 | `INVALID_RESPONSE_CONFIG` | 用日志中的规则 ID 和版本检查生效配置。 |
| 500 | `INTERNAL_ERROR` | 用请求 ID 定位运行故障，检查本地数据库和服务状态。 |

管理员或观察者可读取 `GET /api/v1/namespaces/qa/metrics`。计数按进程和命名空间统计已授权调用。`calls` 为调用数，`hits` 为命中数，`misses` 为未命中数，`errors` 为系统或请求错误数。配置的 4xx 和 5xx 响应计入命中。进程重启时指标归零。

```sh
curl -fsS -H "$admin" "$MOCK_URL/api/v1/namespaces/qa/metrics"
node --test test/*.test.cjs
```
