# 古籍拓片缺损修补 API

纯后端零依赖 Node 服务，使用 `data/db.json` 持久化拓片、缺损项、修补批次与裱板养护占用账。

## 启动

```bash
PORT=3020 node server.js
```

## 裱板养护排程

排程逻辑拆在 `scheduling/` 三个文件中：

- `scheduling/rules.js` —— 判定层（纯函数）：温湿度区间、同养护位时段交叉、同拓片当天≤2。
- `scheduling/ledger.js` —— 占用账：养护位预约的记账、释放与结项留档（随 `db.json` 写回）。
- `scheduling/index.js` —— 服务入口：建批/开工/改约/取消/结项的编排。

缺损状态机：

```
pending_verification（旧缺损缺环境值待核验）
pending → scheduled → started → repaired
                      ↘ cancelled（仅未开工可取消）
started 改动预约/环境值 → pending_review（释放养护位）→ reschedule 回到 scheduled
```

建批规则（`POST /batches`，每项须登记养护位 `slot`、起止时刻、温湿度）：

- 温度须在 **18~26°C**、湿度 **40~60%**（均含边界）；
- **同一养护位**时段按半开区间 `[start,end)` 判定交叉（首尾相接不算）；
- **同一拓片每天最多两块**（按预约覆盖的自然日计，跨天预约逐日计入）；
- 任一冲突或旧缺损未核验，整批返回 **409 且不写入**；响应 `conflicts` 给出明细：
  `env_out_of_range` / `slot_overlap` / `daily_limit` / `env_unverified`。

其他要点：

- **开工**（`POST /batches/:id/start`）后，`PATCH /damages/:id` 改动 `slot/startAt/endAt/temperature/humidity` 任一项，该缺损回 `pending_review` 并释放养护位（账目标 `released/changed_after_start`），新值留痕待复核；用 `POST /damages/:id/reschedule` 重新登记。
- 未开工改约直接生效，但同样过三类判定，冲突返回 409 且不改写。
- **取消**（`POST /batches/:id/cancel`，可带 `damageIds`）只释放 `scheduled` 未开工项；已开工项不可取消。
- **结项**（`POST /batches/:id/complete`）只结 `started` 项，占用账标 `archived` 永久留档，养护位随之释放；仍有 `scheduled/pending_review` 项时 409。
- 旧数据首次读取自动迁移：旧缺损补 `envVerified:false` 并置 `pending_verification`，用 `POST /damages/:id/verify-env` 补环境基线核验后才能排程。

## 接口

- `GET /health`
- `GET /rubbings`
- `POST /rubbings`
- `GET /rubbings/:id/damages`
- `POST /rubbings/:id/damages`
- `GET /damages?status=&type=&envVerified=`
- `PATCH /damages/:id`（可改养护字段，开工后触发待复核）
- `POST /damages/:id/verify-env`（旧缺损补环境值核验）
- `POST /damages/:id/reschedule`（待复核项重新登记养护位）
- `GET /curing/bookings?status=&slot=`（占用账：scheduled/started/released/archived）
- `GET /batches`
- `POST /batches`
- `GET /batches/:id`
- `POST /batches/:id/start`
- `POST /batches/:id/cancel`
- `POST /batches/:id/complete`

## 建批示例

```bash
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "九月裱板养护批",
    "items": [
      {"damageId":"damage_demo_1","slot":"A-01","startAt":"2026-09-23T08:00","endAt":"2026-09-23T12:00","temperature":22,"humidity":50},
      {"damageId":"damage_demo_2","slot":"A-02","startAt":"2026-09-23T13:00","endAt":"2026-09-23T17:00","temperature":20,"humidity":45}
    ]
  }'
```
