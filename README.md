# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项、修补批次与裱板养护占用账。

## 启动

```bash
PORT=3020 node server.js
```

## 代码结构

- `server.js` — HTTP 入口（路由、请求解析、读写 `data/db.json`）
- `rules.js` — 排程判定：环境阈值、起止时刻解析、养护位时段交叉、同拓片当天限额、整批校验
- `occupancy.js` — 养护位占用账：占用/开工/释放/改约重占/取消/结项留档，以及旧缺损待核验迁移

## 主要接口

- `GET /health`
- `GET /rubbings` / `POST /rubbings`
- `GET /rubbings/:id/damages` / `POST /rubbings/:id/damages`
- `GET /damages?status=&type=`
- `PATCH /damages/:id`（改登记信息；改养护预约/温湿度按排程规则处理）
- `POST /damages/:id/start`（单项开工）
- `GET /batches` / `POST /batches`
- `GET /batches/:id`
- `POST /batches/:id/start`（整批开工，有待复核项则 409）
- `POST /batches/:id/cancel`（只释放未开工项，已开工的继续占用）
- `POST /batches/:id/complete`（结项，占用账留档不释放）

## 裱板养护排程规则

建批（`POST /batches`）时每个缺损项必须登记养护位、起止时刻、温度（℃）、湿度（%）：

```json
{
  "name": "十月小批",
  "items": [
    {
      "damageId": "damage_demo_1",
      "slotId": "裱板位-A",
      "startAt": "2026-10-01T09:00:00+08:00",
      "endAt": "2026-10-01T10:30:00+08:00",
      "temperatureC": 22,
      "humidityPct": 50
    }
  ]
}
```

任一不满足时整批返回 `409`，冲突明细在 `conflicts` 中，且不写入任何数据：

- `slot_time_overlap`：同一养护位时段交叉（半开区间，首尾相接不算；本批内部互查，也与占用账互查）
- `daily_limit_exceeded`：同一张拓片当天（按 +08:00 自然日）超过两块
- `environment_out_of_range`：温度不在 18~26℃、湿度不在 40~60%（含边界）

## 缺损状态流转

- `pending` 待排程（新建缺损）
- `verification_pending` 待核验：旧缺损缺少养护环境值，建批补登温湿度后自动解除
- `scheduled` 已排程：占用养护位，未开工
- `in_repair` 已开工
- `review_pending` 待复核：**开工后**改动养护位/起止时刻/温湿度，立即释放养护位并回此状态；改后的值不占账，需重新提交并通过判定才会重新占用、回到 `scheduled`
- `repaired` 已结项

## 取消与结项

- 取消批次：仅释放 `scheduled`（未开工）项，缺损回 `pending`；`in_repair` 项继续占用，批次保留在册直至结项
- 结项：账上占用页转 `archived` 留档（可在 `curingBookings` 中追溯养护位与温湿度），不再占用养护位

## 闭环示例

```bash
curl http://127.0.0.1:3020/damages?status=verification_pending
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"十月小批","items":[{"damageId":"damage_demo_1","slotId":"裱板位-A","startAt":"2026-10-01T09:00:00+08:00","endAt":"2026-10-01T10:30:00+08:00","temperatureC":22,"humidityPct":50},{"damageId":"damage_demo_2","slotId":"裱板位-B","startAt":"2026-10-01T10:00:00+08:00","endAt":"2026-10-01T11:30:00+08:00","temperatureC":20,"humidityPct":45}]}'
curl -X POST http://127.0.0.1:3020/batches/<batchId>/start
curl -X POST http://127.0.0.1:3020/batches/<batchId>/complete
```
