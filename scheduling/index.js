"use strict";

// 裱板养护排程 —— 服务入口（建批/开工/改约/取消/结项的编排；判定在 rules，占用账在 ledger）

const rules = require("./rules");
const ledger = require("./ledger");

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const DAMAGE_STATUSES = ["pending", "pending_verification", "scheduled", "started", "pending_review", "cancelled", "repaired"];

// ---------- 旧数据迁移：旧缺损缺环境值，标为待核验 ----------
function migrate(db) {
  let changed = false;
  if (!Array.isArray(db.curingBookings)) {
    db.curingBookings = [];
    changed = true;
  }
  for (const damage of db.damages) {
    if (damage.envVerified === undefined) {
      damage.envVerified = false;
      changed = true;
    }
    if (damage.curing === undefined) {
      damage.curing = null;
      changed = true;
    }
    if (damage.reviewNote === undefined) {
      damage.reviewNote = "";
      changed = true;
    }
    // 旧库里“待修补但从未登记环境基线”的缺损，单独列为待核验
    if (damage.status === "pending" && !damage.envVerified) {
      damage.status = "pending_verification";
      changed = true;
    }
  }
  return changed;
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getDamage(db, damageId) {
  const damage = db.damages.find((item) => item.id === damageId);
  if (!damage) throw new HttpError(404, "缺损项不存在");
  return damage;
}

function getBatch(db, batchId) {
  const batch = db.batches.find((item) => item.id === batchId);
  if (!batch) throw new HttpError(404, "修补批次不存在");
  return batch;
}

function applyCuring(damage, booking) {
  damage.curing = {
    bookingId: booking.id,
    slot: booking.slot,
    startAt: booking.startAt,
    endAt: booking.endAt,
    temperature: booking.temperature,
    humidity: booking.humidity,
    bookedAt: booking.createdAt
  };
}

function clearCuring(damage) {
  damage.curing = null;
}

// ---------- 建批：登记养护位/起止时刻/温湿度；任一冲突整批 409，不写入 ----------
function createBatch(db, body) {
  if (!body.name) throw new HttpError(400, "缺少字段：name");
  const rawItems = body.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new HttpError(400, "items必须是非空数组");
  }

  const shapeErrors = [];
  const seen = new Set();
  rawItems.forEach((raw, index) => {
    if (!raw || raw.damageId === undefined || raw.damageId === "") {
      shapeErrors.push({ index, damageId: raw && raw.damageId, errors: [{ field: "damageId", reason: "missing" }] });
      return;
    }
    if (seen.has(raw.damageId)) shapeErrors.push({ index, damageId: raw.damageId, errors: [{ field: "damageId", reason: "duplicate" }] });
    seen.add(raw.damageId);
    const errors = rules.validateItemShape(raw);
    if (errors.length) shapeErrors.push({ index, damageId: raw.damageId, errors });
  });
  if (shapeErrors.length) throw new HttpError(400, "预约信息不合法", { details: shapeErrors });

  const items = [];
  const notFound = [];
  const notSchedulable = [];
  const unverified = [];
  for (const raw of rawItems) {
    const damage = db.damages.find((item) => item.id === raw.damageId);
    if (!damage) {
      notFound.push(raw.damageId);
      continue;
    }
    // 旧缺损缺环境值待核验：未核验前不得占用养护位
    if (!damage.envVerified) unverified.push(raw.damageId);
    if (!["pending", "pending_verification"].includes(damage.status)) {
      notSchedulable.push({ damageId: damage.id, status: damage.status });
    }
    items.push({
      damageId: damage.id,
      rubbingId: damage.rubbingId,
      slot: raw.slot,
      startAt: raw.startAt,
      endAt: raw.endAt,
      temperature: Number(raw.temperature),
      humidity: Number(raw.humidity)
    });
  }
  if (notFound.length) throw new HttpError(400, `缺损项不存在：${notFound.join(", ")}`);
  if (notSchedulable.length) {
    throw new HttpError(409, "存在非待排程状态的缺损项，整批未写入", {
      reason: "damage_not_schedulable",
      details: notSchedulable
    });
  }

  // 三类冲突统一判 409：环境超区间、同位时段交叉、同拓片当天超两块；未核验旧缺损一并拦下
  const conflicts = rules.evaluateConflicts(items, ledger.activeBookings(db));
  if (unverified.length) {
    conflicts.push({ code: "env_unverified", damageIds: unverified, message: "旧缺损缺环境值，待核验" });
  }
  if (conflicts.length) {
    throw new HttpError(409, "养护排程冲突，整批返回且不写入", { conflicts });
  }

  // 判定通过后才动数据
  const now = new Date().toISOString();
  const batch = {
    id: makeId("batch"),
    name: body.name,
    status: "open",
    damageIds: items.map((item) => item.damageId),
    schedule: items.map((item) => ({
      damageId: item.damageId,
      slot: item.slot,
      startAt: item.startAt,
      endAt: item.endAt,
      temperature: item.temperature,
      humidity: item.humidity
    })),
    note: body.note || "",
    createdAt: now,
    startedAt: null,
    cancelledAt: null,
    cancelledDamageIds: [],
    completedAt: null
  };
  db.batches.push(batch);

  for (const item of items) {
    const damage = getDamage(db, item.damageId);
    const booking = ledger.reserve(db, item, { batchId: batch.id, status: "scheduled" });
    damage.batchId = batch.id;
    damage.status = "scheduled";
    damage.reviewNote = "";
    applyCuring(damage, booking);
  }
  return batch;
}

// ---------- 开工：scheduled → started ----------
function startBatch(db, batchId, body = {}) {
  const batch = getBatch(db, batchId);
  if (!["open", "in_progress"].includes(batch.status)) {
    throw new HttpError(409, `批次当前状态（${batch.status}）不可开工`, { reason: "batch_not_open" });
  }
  const only = Array.isArray(body.damageIds) && body.damageIds.length ? body.damageIds : batch.damageIds;
  const targets = batch.damageIds
    .filter((id) => only.includes(id))
    .map((id) => getDamage(db, id))
    .filter((damage) => damage.status !== "cancelled" && damage.status !== "repaired");

  if (!targets.length) {
    throw new HttpError(409, "没有可开工的已预约缺损项", { reason: "no_scheduled_items" });
  }
  const blocked = targets.filter((damage) => damage.status !== "scheduled");
  if (blocked.length) {
    throw new HttpError(409, "存在未处于已预约状态的缺损项，不可开工", {
      reason: "damage_not_scheduled",
      details: blocked.map((damage) => ({ damageId: damage.id, status: damage.status }))
    });
  }

  const now = new Date().toISOString();
  for (const damage of targets) {
    const booking = ledger.activeBookingForDamage(db, damage.id);
    if (!booking) throw new HttpError(500, `占用账缺失：${damage.id}`);
    ledger.markStarted(db, booking, now);
    damage.status = "started";
    applyCuring(damage, booking);
  }
  batch.status = "in_progress";
  if (!batch.startedAt) batch.startedAt = now;
  return batch;
}

// ---------- 取消：只释放未开工项 ----------
function cancelBatch(db, batchId, body = {}) {
  const batch = getBatch(db, batchId);
  if (batch.status === "completed") throw new HttpError(409, "批次已结项，不可取消", { reason: "batch_completed" });
  if (batch.status === "cancelled") throw new HttpError(409, "批次已取消", { reason: "batch_cancelled" });

  const only = Array.isArray(body.damageIds) && body.damageIds.length ? body.damageIds : batch.damageIds;
  const targets = batch.damageIds
    .filter((id) => only.includes(id))
    .map((id) => getDamage(db, id))
    .filter((damage) => damage.status === "scheduled");

  if (!targets.length) {
    throw new HttpError(409, "没有可取消的未开工项（开工后不可取消）", { reason: "no_unstarted_items" });
  }

  const now = new Date().toISOString();
  for (const damage of targets) {
    const booking = ledger.activeBookingForDamage(db, damage.id);
    if (booking) ledger.release(db, booking, "cancel", now);
    damage.status = "cancelled";
    damage.curing = null;
    damage.reviewNote = "";
    if (!batch.cancelledDamageIds.includes(damage.id)) batch.cancelledDamageIds.push(damage.id);
  }

  const remaining = batch.damageIds
    .map((id) => getDamage(db, id))
    .filter((damage) => damage.status !== "cancelled" && damage.status !== "repaired");
  if (remaining.length === 0) {
    batch.status = "cancelled";
    batch.cancelledAt = now;
  } else {
    batch.status = "in_progress";
  }
  return batch;
}

// ---------- 结项：只结开工项，占用账留档 ----------
function completeBatch(db, batchId, body = {}) {
  const batch = getBatch(db, batchId);
  if (batch.status === "completed") throw new HttpError(409, "批次已结项", { reason: "batch_completed" });
  if (batch.status === "cancelled") throw new HttpError(409, "批次已取消，不可结项", { reason: "batch_cancelled" });

  const blockers = batch.damageIds
    .map((id) => getDamage(db, id))
    .filter((damage) => !["started", "repaired", "cancelled"].includes(damage.status));
  if (blockers.length) {
    throw new HttpError(409, "存在未开工或待复核的缺损项，不能结项", {
      reason: "damage_not_started",
      details: blockers.map((damage) => ({ damageId: damage.id, status: damage.status }))
    });
  }

  const results = Array.isArray(body.results) ? body.results : [];
  const now = new Date().toISOString();
  for (const id of batch.damageIds) {
    const damage = getDamage(db, id);
    if (damage.status !== "started") continue;
    const result = results.find((item) => item.damageId === damage.id) || {};
    const booking = ledger.activeBookingForDamage(db, damage.id);
    if (booking) ledger.archive(db, booking, now);
    damage.status = "repaired";
    damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
    damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
    damage.repairedAt = now;
    damage.curing = null;
    damage.reviewNote = "";
  }
  batch.status = "completed";
  batch.completedAt = now;
  batch.note = body.note ?? batch.note;
  return batch;
}

// 把改动合并进现有预约并做结构/冲突判定
function buildMergedItem(damage, booking, patch) {
  const merged = {
    damageId: damage.id,
    rubbingId: damage.rubbingId,
    slot: patch.slot ?? booking.slot,
    startAt: patch.startAt ?? booking.startAt,
    endAt: patch.endAt ?? booking.endAt,
    temperature: patch.temperature ?? booking.temperature,
    humidity: patch.humidity ?? booking.humidity
  };
  const errors = rules.validateItemShape(merged);
  if (errors.length) throw new HttpError(400, "预约信息不合法", { details: [{ damageId: damage.id, errors }] });
  merged.temperature = Number(merged.temperature);
  merged.humidity = Number(merged.humidity);
  return merged;
}

function assertNoConflicts(db, item) {
  const conflicts = rules.evaluateConflicts([item], ledger.activeBookings(db));
  if (conflicts.length) throw new HttpError(409, "养护排程冲突，改动未保存", { conflicts });
}

// ---------- 改预约/环境值：开工后改动 → 回待复核并释放养护位 ----------
function patchDamage(db, damageId, patch) {
  const damage = getDamage(db, damageId);
  const booking = ledger.activeBookingForDamage(db, damageId);

  const next = {
    position: patch.position,
    type: patch.type,
    beforePhotoUrl: patch.beforePhotoUrl,
    afterPhotoUrl: patch.afterPhotoUrl,
    repairNote: patch.repairNote
  };
  for (const [field, value] of Object.entries(next)) {
    if (value !== undefined) damage[field] = value;
  }
  if (patch.status !== undefined) {
    if (!DAMAGE_STATUSES.includes(patch.status)) throw new HttpError(400, `非法状态：${patch.status}`);
    damage.status = patch.status;
    damage.repairedAt = patch.status === "repaired" ? new Date().toISOString() : damage.repairedAt;
  }

  const changed = booking ? rules.changedFields(booking, patch) : {};
  if (Object.keys(changed).length === 0) return damage;
  if (!booking) throw new HttpError(400, "该项没有进行中的养护预约，不能改约", { reason: "no_active_booking" });

  const merged = buildMergedItem(damage, booking, changed);

  if (booking.status === "started") {
    // 开工后改动：释放养护位、回待复核；新值登记在案待人工复核
    const now = new Date().toISOString();
    ledger.release(db, booking, "changed_after_start", now);
    booking.history.push({ at: now, action: "review_pending", changed, proposed: merged });
    damage.status = "pending_review";
    damage.curing = null;
    damage.reviewNote = patch.reviewNote || "开工后改动预约/环境值，已释放养护位，待复核";
    damage.reviewChangedAt = now;
    return damage;
  }

  // 未开工：允许直接改约，但仍要过全部判定
  assertNoConflicts(db, merged);
  const now = new Date().toISOString();
  Object.assign(booking, {
    slot: merged.slot,
    startAt: merged.startAt,
    endAt: merged.endAt,
    temperature: merged.temperature,
    humidity: merged.humidity
  });
  booking.history.push({ at: now, action: "rescheduled", changed });
  applyCuring(damage, booking);
  return damage;
}

// ---------- 待复核项重新登记养护位 ----------
function rescheduleDamage(db, damageId, patch = {}) {
  const damage = getDamage(db, damageId);
  if (damage.status !== "pending_review") {
    throw new HttpError(409, "只有待复核项可以重新登记养护位", {
      reason: "not_pending_review",
      currentStatus: damage.status
    });
  }
  const item = {
    damageId: damage.id,
    rubbingId: damage.rubbingId,
    slot: patch.slot,
    startAt: patch.startAt,
    endAt: patch.endAt,
    temperature: patch.temperature,
    humidity: patch.humidity
  };
  const errors = rules.validateItemShape(item);
  if (errors.length) throw new HttpError(400, "预约信息不合法", { details: [{ damageId: damage.id, errors }] });
  item.temperature = Number(item.temperature);
  item.humidity = Number(item.humidity);
  assertNoConflicts(db, item);

  const booking = ledger.reserve(db, item, { batchId: damage.batchId, status: "scheduled" });
  damage.status = "scheduled";
  damage.reviewNote = "";
  damage.reviewChangedAt = null;
  applyCuring(damage, booking);
  return damage;
}

// ---------- 旧缺损补环境值，核验通过 ----------
function verifyEnv(db, damageId, patch = {}) {
  const damage = getDamage(db, damageId);
  const temperature = Number(patch.temperature);
  const humidity = Number(patch.humidity);
  if (!rules.isNumber(temperature) || !rules.isNumber(humidity)) {
    throw new HttpError(400, "temperature与humidity必须是数字");
  }
  if (!rules.envInRange(temperature, humidity)) {
    throw new HttpError(400, "环境基线不在允许区间（温度18~26°C，湿度40~60%）", {
      reason: "env_out_of_range",
      allowed: { temperature: rules.TEMP_RANGE, humidity: rules.HUMIDITY_RANGE }
    });
  }
  damage.envBaseline = { temperature, humidity, verifiedAt: new Date().toISOString() };
  damage.envVerified = true;
  if (damage.status === "pending_verification") damage.status = "pending";
  return damage;
}

// ---------- 批次视图（含养护排程） ----------
function enrichBatch(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  const countBy = (status) => damages.filter((item) => item.status === status).length;
  return {
    ...batch,
    damages,
    total: damages.length,
    repaired: damages.filter((item) => item.status === "repaired").length,
    pending: damages.filter((item) => !["repaired", "cancelled"].includes(item.status)).length,
    statusCounts: {
      scheduled: countBy("scheduled"),
      started: countBy("started"),
      pending_review: countBy("pending_review"),
      cancelled: countBy("cancelled"),
      repaired: countBy("repaired")
    }
  };
}

module.exports = {
  HttpError,
  DAMAGE_STATUSES,
  migrate,
  createBatch,
  startBatch,
  cancelBatch,
  completeBatch,
  patchDamage,
  rescheduleDamage,
  verifyEnv,
  enrichBatch,
  ledger,
  rules
};
