# ai-coding-test

## Mock 系统设计（NYF-36）

供开发、联调和测试使用。调用方发送真实形状的 HTTP 请求，系统按配置返回可重复的 HTTP 响应。首批支持固定响应、按请求条件分流和固定延迟。转发、脚本执行、跨请求业务状态和随机故障注入留待后续设计。

### 管理面与调用面

| 面 | 入口 | 职责 | 权限 |
| --- | --- | --- | --- |
| 管理面 | `/api/v1/namespaces/{namespace}/rules` | 校验配置、创建规则和版本、查询历史、启停或切换版本、软删除 | 命名空间管理员可读写，命名空间观察者只读 |
| 调用面 | `/mock/{namespace}/{path...}` | 从命名空间的启用版本中匹配请求并返回配置的响应 | 需要该命名空间的调用权限，管理凭据与调用凭据分别使用 |

命名空间是规则、权限和匹配的隔离单位，由平台预先分配。两个入口都使用 `Authorization: Bearer <token>`。缺失或无效凭据返回 `401`，有效凭据缺少相应入口或目标命名空间的权限返回 `403`。管理面的 `Authorization` 和调用面的 `Authorization` 均用于系统鉴权，调用方可用业务请求头表达需要匹配的业务身份。

### 数据模型与配置规则

| 实体 | 字段与约束 |
| --- | --- |
| `Namespace` | `key` 为唯一且稳定的 URL 段，权限按 `key` 授予。 |
| `Rule` | `id` 由服务端生成，`namespace` 与 `name` 在创建后固定，`state` 为 `disabled`、`enabled` 或 `deleted`，`activeVersion` 为生效版本号或 `null`，`latestVersion` 为最近创建的版本号，`revision` 为从 1 开始递增的管理修订号。`name` 为非空字符串，允许重名，管理操作以 `id` 定位。 |
| `RuleVersion` | 由 `ruleId` 与从 1 开始递增的 `version` 标识。包含必填 `match`、`response` 与可选 `priority`，`priority` 默认为 0，范围为 0–1000 的整数，数值越大越优先。版本创建后不可修改。 |
| `Match` | 必填 `method` 和 `path`，可选 `query`、`headers`、`jsonBody` 条件映射，缺省均为空。所有已配置条件同时满足才命中。 |
| `Response` | `status` 必填，范围为 200–599 的整数。`headers` 为可选的单值字符串映射。`body` 为可选 JSON 值，省略时为空响应体，显式 `null` 返回 JSON `null`。`delayMs` 默认为 0，范围为 0–5000 的整数。 |

管理请求使用 `application/json`。拒绝未知字段、重复 JSON 键、类型错误、越界值及非法条件，返回 `400 INVALID_CONFIG`。响应头名须为合法 HTTP 字段名，同名检查忽略大小写，值禁止包含 CR、LF。`Content-Length`、`Transfer-Encoding` 和逐跳头由系统处理，配置中禁止设置。配置了响应体时系统设置 `Content-Type: application/json`，若配置显式声明该头，其媒体类型须为 `application/json`。`204`、`205` 和 `304` 禁止配置响应体，`HEAD` 规则也禁止配置响应体。

### 请求匹配

- `method` 精确匹配大写 `GET`、`HEAD`、`POST`、`PUT`、`PATCH`、`DELETE` 或 `OPTIONS`。`HEAD` 使用独立规则。
- `path` 为去掉 `/mock/{namespace}` 后的绝对路径，例如 `/orders/42`。按原始 URL 路径文本精确比较，大小写、尾斜杠和百分号编码拼写均有意义。配置路径禁止查询串、片段、通配符和参数模板。根路径使用 `/`。
- `query` 的键和值为字符串，按 UTF-8 查询参数解析后的值精确匹配，键区分大小写，`+` 解析为空格。配置的键必须在请求中恰好出现一次，未配置的键不参与匹配。非法百分号编码或非法 UTF-8 返回 `400 INVALID_REQUEST`。
- `headers` 的键为合法 HTTP 字段名，按大小写不敏感比较，配置中同名键禁止重复。值为字符串，与请求字段值去掉首尾空格和水平制表符后精确比较，配置值也按此规则归一化。同名字段出现多次时按接收顺序用 `, ` 合并后比较。禁止匹配用于系统鉴权的 `Authorization`。
- `jsonBody` 的键为指向字段的非空 RFC 6901 JSON Pointer，例如 `/channel` 或 `/items/0/id`，值仅支持 JSON 标量。按 JSON 类型和值匹配，字段缺失与字段值 `null` 有区别。仅当候选规则配置了 `jsonBody` 时才检查该规则的请求体。缺失请求体、媒体类型非 `application/json`、JSON 解析失败或重复键会让该规则不命中，请求仍可匹配其他规则。
- 匹配按同命名空间、同方法和同路径筛选启用版本，再按优先级从高到低检查条件。每个 `(namespace, method, path, priority)` 最多有一个启用版本。即便条件互斥，同一优先级也只能占用一次，可给条件规则和兜底规则分配不同优先级。草稿允许重叠，启用或切换时检查冲突。
- 无规则命中返回 `404 MOCK_RULE_NOT_FOUND`。命中后按配置等待 `delayMs` 并发送响应。配置的业务错误直接使用规则中的状态码、头和响应体。系统错误统一使用 `{"error":{"code":"…","message":"…"}}`，字段校验错误可附带 `error.fields`，规则冲突可附带 `error.conflictingRuleId`。

### 管理 API

下表的相对路径以 `/api/v1/namespaces/{namespace}/rules` 为基准。列表和详情返回 `Rule`，版本接口返回 `RuleVersion`。管理写操作成功后返回最新的强 ETag，值为带双引号的 `revision`，例如 `"2"`。

| 方法与相对路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `POST /` | `{name, match, response, priority?}`，带 `Idempotency-Key` | `201`，返回 `Rule`，`Location` 指向规则详情。创建禁用规则与版本 1。 |
| `GET /` | 可选 `state=enabled` 或 `state=disabled` | `200 {items: Rule[]}`，按 `id` 升序返回。可省略末尾 `/`。 |
| `GET /{id}` | 无请求体 | `200 Rule`，带 ETag。 |
| `GET /{id}/versions` | 无请求体 | `200 {items: RuleVersion[]}`，按版本号降序返回。 |
| `GET /{id}/versions/{version}` | 无请求体 | `200 RuleVersion`。 |
| `PUT /{id}` | 完整 `{match, response, priority?}`，带 `If-Match` | `200 Rule`。创建新版本并更新 `latestVersion`，当前生效版本继续服务。与最近版本的规范化配置完全相同时直接返回现有规则。 |
| `PUT /{id}/state` | `{"state":"enabled","version":2}` 或 `{"state":"disabled"}`，带 `If-Match` | `200 Rule`。启用或切换到指定版本时要求显式版本号，禁用时省略版本号并清空 `activeVersion`。 |
| `DELETE /{id}` | 带 `If-Match`，无请求体 | `204`。软删除规则，撤下生效版本并保留内部历史记录。 |

对规则详情、版本和写操作，目标规则缺失或已删除返回 `404 RULE_NOT_FOUND`。请求引用不存在的版本返回 `404 VERSION_NOT_FOUND`。缺少 `If-Match` 返回 `428 PRECONDITION_REQUIRED`，ETag 过期返回 `412 REVISION_MISMATCH`。启用或切换时占用已存在的匹配槽返回 `409 RULE_CONFLICT`。

### 生命周期、并发与重试

| 当前状态 | 操作 | 结果 |
| --- | --- | --- |
| 无 | 创建 | `disabled`，`latestVersion=1`，`activeVersion=null` |
| `disabled` 或 `enabled` | 更新配置 | 创建下一个不可变版本，状态和生效版本保持原值 |
| `disabled` | 启用版本 N | `enabled`，`activeVersion=N` |
| `enabled` | 启用版本 N | `enabled`，`activeVersion=N`，可切到旧版本完成回滚 |
| `enabled` | 禁用 | `disabled`，`activeVersion=null` |
| `disabled` 或 `enabled` | 删除 | `deleted`，`activeVersion=null`。列表、详情、版本接口与调用面均隐藏该规则 |

- 创建规则时要求非空 `Idempotency-Key`，缺失返回 `400 IDEMPOTENCY_KEY_REQUIRED`。成功结果按调用主体、命名空间和键保存 24 小时。相同键及相同 JSON 请求重放首次 `201` 响应，包括 `Location` 和原 ETag。比较时忽略对象键顺序和 JSON 空白。相同键加不同请求体返回 `409 IDEMPOTENCY_KEY_REUSED`。同键并发提交只允许一次创建，后续请求按首次提交结果处理。配置非法的请求不占用键。
- 管理写入先校验版本前置条件，再执行变更。同一规则的并发写入以 `revision` 检测覆盖，实际变更时修订号加一。重复启用当前版本、重复禁用和相同配置更新都不增加修订号。写入结果丢失时，可用 `GET` 确认最新状态，后续写入使用新的 ETag。
- 启用、切换、禁用和删除与匹配槽的变更原子提交。冲突检查和生效指针更新在同一次提交中完成。一次调用使用开始匹配时已提交的规则快照，版本切换期间已选中旧版本的调用可正常完成，提交后开始匹配的调用使用新版本。
- 调用面每次都重新匹配，无去重、计数或请求间状态。规则快照相同且请求条件相同的重复调用返回相同的配置状态码、响应头和响应体。

### 首批业务场景

示例使用命名空间 `qa`。管理请求带管理凭据，调用请求带调用凭据。JSON 请求体使用 `Content-Type: application/json`。响应示例展示状态码与完整业务响应体。

| 场景 | 版本配置 `{match, response, priority?}` | 调用请求 | 预期响应 |
| --- | --- | --- | --- |
| 查询已创建订单 | `{"match":{"method":"GET","path":"/orders/42","query":{"include":"items"}},"response":{"status":200,"body":{"id":42,"items":[{"sku":"A1"}]}}}` | `GET /mock/qa/orders/42?include=items` | `200`，`{"id":42,"items":[{"sku":"A1"}]}` |
| 信用卡支付被拒 | `{"match":{"method":"POST","path":"/payments","headers":{"X-Client":"checkout"},"jsonBody":{"/channel":"card"}},"response":{"status":422,"body":{"code":"CARD_DECLINED"}},"priority":10}` | `POST /mock/qa/payments`，带 `X-Client: checkout`，请求体 `{"channel":"card","amount":100}` | `422`，`{"code":"CARD_DECLINED"}` |
| 库存服务暂时不可用 | `{"match":{"method":"GET","path":"/inventory/A1"},"response":{"status":503,"headers":{"Retry-After":"2"},"body":{"code":"INVENTORY_UNAVAILABLE"},"delayMs":250}}` | `GET /mock/qa/inventory/A1` | 配置延迟 250 ms 后返回 `503`，带 `Retry-After: 2`，响应体 `{"code":"INVENTORY_UNAVAILABLE"}` |

### 端到端走查

以下流程从没有相关规则的 `qa` 命名空间开始。`r1` 代表创建响应中的实际 `id`。

1. `POST /api/v1/namespaces/qa/rules`，带 `Idempotency-Key: order-42-create`，请求体如下面的示例。期望 `201`、`Location: /api/v1/namespaces/qa/rules/r1`、`ETag: "1"`。规则处于 `disabled`，`latestVersion=1`，`activeVersion=null`。此时调用 `GET /mock/qa/orders/42?include=items`，期望 `404 MOCK_RULE_NOT_FOUND`。
2. `PUT /api/v1/namespaces/qa/rules/r1/state`，带 `If-Match: "1"`，请求体 `{"state":"enabled","version":1}`。期望 `200`、`ETag: "2"` 与 `activeVersion=1`。再次调用订单接口，期望 `200` 与 `{"id":42,"items":[{"sku":"A1"}]}`。
3. `PUT /api/v1/namespaces/qa/rules/r1`，带 `If-Match: "2"`，请求体使用下面示例中的完整 `match` 和 `response`，将 `sku` 改为 `B2`，省略 `name`。期望 `ETag: "3"`、`latestVersion=2`、`activeVersion=1`。`GET /api/v1/namespaces/qa/rules/r1/versions/2` 可查到 `B2`，调用面仍返回 `A1`。
4. `PUT /api/v1/namespaces/qa/rules/r1/state`，带 `If-Match: "3"` 与 `{"state":"enabled","version":2}`，期望 `ETag: "4"`，调用返回 `B2`。使用 `If-Match: "4"` 和 `{"state":"enabled","version":1}` 回滚，期望 `ETag: "5"`，调用返回 `A1`。
5. 用 `If-Match: "5"` 提交 `{"state":"disabled"}` 到状态接口，期望 `ETag: "6"`，调用返回 `404 MOCK_RULE_NOT_FOUND`。随后 `DELETE /api/v1/namespaces/qa/rules/r1`，带 `If-Match: "6"`，期望 `204`，再次查询详情返回 `404 RULE_NOT_FOUND`。

```json
{
  "name": "读取订单 42",
  "match": { "method": "GET", "path": "/orders/42", "query": { "include": "items" } },
  "response": { "status": 200, "body": { "id": 42, "items": [{ "sku": "A1" }] } }
}
```

### 验收用例

| 输入或操作 | 预期结果 |
| --- | --- |
| 用三个业务场景的配置分别创建并启用规则，发送各自的请求 | 得到场景表中的状态码、响应体、配置的响应头及延迟。 |
| 在创建请求中省略 `response.status`，其余字段合法 | `400 INVALID_CONFIG`，错误指向 `/response/status`，没有创建规则或版本。 |
| 支付规则的 `jsonBody` 使用键 `channel` 或使用对象作为匹配值 | `400 INVALID_CONFIG`，错误指向对应匹配条件。 |
| 订单规则启用后，以另一幂等键创建同路径、同方法、同优先级的禁用规则，再尝试启用 | 创建返回 `201`，启用返回 `409 RULE_CONFLICT`。原规则继续服务，新规则仍为 `disabled`。 |
| 创建同一支付路径、优先级 `0`、无附加条件的兜底规则，启用后分别发送符合和缺少信用卡条件的请求 | 符合条件时命中优先级 `10` 的拒付规则，缺少条件时命中优先级 `0` 的兜底。 |
| 向订单规则发送无 `include` 或重复 `include` 的请求，且无兜底规则 | `404 MOCK_RULE_NOT_FOUND`。 |
| 在 24 小时内使用同一 `Idempotency-Key` 重放创建请求，再用该键创建不同配置 | 首次重放返回原 `201`、规则 ID 和 ETag。不同配置返回 `409 IDEMPOTENCY_KEY_REUSED`。 |
| 版本切换后使用旧 ETag 尝试停用 | `412 REVISION_MISMATCH`，新版本继续生效。 |
| 使用调用凭据创建规则，或访问无调用授权的命名空间 | 两种请求均返回 `403`。 |

产品或研发评审可按 API 表和生命周期表逐项检查，再按端到端走查和验收用例核对首批场景。
