// 裱板养护排程：判定模块
// 环境标准：温度 18~26℃（含边界），湿度 40~60%（含边界）
// 同一张拓片当天最多两块（以起止时刻在 +08:00 下归属的自然日为准）

const TEMP_MIN = 18;
const TEMP_MAX = 26;
const HUMIDITY_MIN = 40;
const HUMIDITY_MAX = 60;
const MAX_DAMAGES_PER_RUBBING_PER_DAY = 2;
const SCHEDULE_TZ = "Asia/Shanghai";

class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

class ScheduleConflictError extends Error {
  constructor(message, conflicts) {
    super(message);
    this.status = 409;
    this.conflicts = conflicts || [];
  }
}

function environmentStatus(curing) {
  const temp = Number(curing.temperatureC);
  const humidity = Number(curing.humidityPct);
  if (temp < TEMP_MIN || temp > TEMP_MAX) return "temperature_out_of_range";
  if (humidity < HUMIDITY_MIN || humidity > HUMIDITY_MAX) return "humidity_out_of_range";
  return "ok";
}

function isValidEnvironment(curing) {
  return environmentStatus(curing) === "ok";
}

function parseTime(value, fieldLabel) {
  if (typeof value !== "string" || !value.trim()) {
    throw new BadRequestError(`${fieldLabel}必须是ISO时间字符串`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new BadRequestError(`${fieldLabel}时间格式无法解析：${value}`);
  return new Date(ms);
}

// 取时刻在东八区归属的自然日，键格式 YYYY-MM-DD
function dayKeyOf(date) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

// 半开区间 [startAt, endAt) 交叉；首尾相接不算交叉
function intervalsOverlap(a, b) {
  return a.startAt.getTime() < b.endAt.getTime() && b.startAt.getTime() < a.endAt.getTime();
}

// 规整建批时单条养护登记
function normalizeScheduleItem(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BadRequestError("每项缺损的养护登记必须是对象");
  }
  if (raw.damageId === undefined || raw.damageId === "") {
    throw new BadRequestError("养护登记缺少 damageId");
  }
  if (raw.slotId === undefined || raw.slotId === "") {
    throw new BadRequestError(`缺损 ${raw.damageId} 缺少养护位`);
  }
  const startAt = parseTime(raw.startAt, "起始时刻");
  const endAt = parseTime(raw.endAt, "结束时刻");
  if (endAt.getTime() <= startAt.getTime()) {
    throw new BadRequestError(`缺损 ${raw.damageId} 的结束时刻必须晚于起始时刻`);
  }
  const temperatureC = Number(raw.temperatureC);
  const humidityPct = Number(raw.humidityPct);
  if (raw.temperatureC === "" || Number.isNaN(temperatureC)) {
    throw new BadRequestError(`缺损 ${raw.damageId} 缺少温度值`);
  }
  if (raw.humidityPct === "" || Number.isNaN(humidityPct)) {
    throw new BadRequestError(`缺损 ${raw.damageId} 缺少湿度值`);
  }
  return {
    damageId: String(raw.damageId),
    slotId: String(raw.slotId),
    startAt,
    endAt,
    temperatureC,
    humidityPct
  };
}

// heldBookings：占用账中处于占用状态的预约（occupancy.js 提供）
// 新提交的一批项之间也互查，因此 heldBookings 应只含账上已有记录
function validateBatchSchedule(items, db, options = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new BadRequestError("items必须是非空数组，每项含养护位、起止时刻、温湿度");
  }

  const normalized = items.map(normalizeScheduleItem);

  const seenDamage = new Set();
  for (const item of normalized) {
    if (seenDamage.has(item.damageId)) {
      throw new BadRequestError(`缺损重复登记：${item.damageId}`);
    }
    seenDamage.add(item.damageId);
  }

  const damagesById = new Map(db.damages.map((damage) => [damage.id, damage]));
  for (const item of normalized) {
    const damage = damagesById.get(item.damageId);
    if (!damage) throw new BadRequestError(`缺损项不存在：${item.damageId}`);
    item.rubbingId = damage.rubbingId;
  }

  const heldBookings = (db.curingBookings || []).filter(
    (booking) => booking.state === "held" && !options.excludeDamageIds?.includes(booking.damageId)
  );
  for (const booking of heldBookings) {
    booking._startAt = new Date(booking.startAt);
    booking._endAt = new Date(booking.endAt);
  }

  const conflicts = [];

  // 1) 环境值判定
  for (const item of normalized) {
    const env = environmentStatus(item);
    if (env === "temperature_out_of_range") {
      conflicts.push({
        type: "environment_out_of_range",
        damageId: item.damageId,
        field: "temperatureC",
        value: item.temperatureC,
        range: { min: TEMP_MIN, max: TEMP_MAX, unit: "C" },
        message: `缺损 ${item.damageId} 温度 ${item.temperatureC}℃ 不在 ${TEMP_MIN}~${TEMP_MAX}℃ 区间`
      });
    } else if (env === "humidity_out_of_range") {
      conflicts.push({
        type: "environment_out_of_range",
        damageId: item.damageId,
        field: "humidityPct",
        value: item.humidityPct,
        range: { min: HUMIDITY_MIN, max: HUMIDITY_MAX, unit: "%" },
        message: `缺损 ${item.damageId} 湿度 ${item.humidityPct}% 不在 ${HUMIDITY_MIN}~${HUMIDITY_MAX}% 区间`
      });
    }
  }

  // 2) 同一养护位时段交叉（账上 + 本批内部）
  for (let i = 0; i < normalized.length; i += 1) {
    const item = normalized[i];
    for (const booking of heldBookings) {
      if (booking.slotId !== item.slotId) continue;
      if (intervalsOverlap({ startAt: booking._startAt, endAt: booking._endAt }, item)) {
        conflicts.push({
          type: "slot_time_overlap",
          damageId: item.damageId,
          slotId: item.slotId,
          with: { damageId: booking.damageId, bookingId: booking.id },
          message: `养护位 ${item.slotId} 时段与缺损 ${booking.damageId} 的预约交叉`
        });
      }
    }
    for (let j = 0; j < i; j += 1) {
      const other = normalized[j];
      if (other.slotId === item.slotId && intervalsOverlap(other, item)) {
        conflicts.push({
          type: "slot_time_overlap",
          damageId: item.damageId,
          slotId: item.slotId,
          with: { damageId: other.damageId },
          message: `养护位 ${item.slotId} 在本批内时段交叉（缺损 ${other.damageId} / ${item.damageId}）`
        });
      }
    }
  }

  // 3) 同一拓片当天超过两块（账上已有 + 本批自身）
  const perRubbingDay = new Map();
  const bump = (key, damageId) => {
    if (!perRubbingDay.has(key)) perRubbingDay.set(key, []);
    perRubbingDay.get(key).push(damageId);
  };
  for (const booking of heldBookings) {
    bump(`${booking.rubbingId}|${dayKeyOf(booking._startAt)}`, booking.damageId);
  }
  for (const item of normalized) {
    bump(`${item.rubbingId}|${dayKeyOf(item.startAt)}`, item.damageId);
  }
  for (const [key, damageIds] of perRubbingDay) {
    if (damageIds.length > MAX_DAMAGES_PER_RUBBING_PER_DAY) {
      const [rubbingId, day] = key.split("|");
      conflicts.push({
        type: "daily_limit_exceeded",
        rubbingId,
        day,
        damageIds,
        limit: MAX_DAMAGES_PER_RUBBING_PER_DAY,
        message: `拓片 ${rubbingId} 在 ${day} 登记 ${damageIds.length} 块，超过每日 ${MAX_DAMAGES_PER_RUBBING_PER_DAY} 块上限`
      });
    }
  }

  if (conflicts.length) {
    throw new ScheduleConflictError("养护排程冲突，整批未写入", conflicts);
  }

  return normalized;
}

module.exports = {
  TEMP_MIN,
  TEMP_MAX,
  HUMIDITY_MIN,
  HUMIDITY_MAX,
  MAX_DAMAGES_PER_RUBBING_PER_DAY,
  SCHEDULE_TZ,
  BadRequestError,
  ScheduleConflictError,
  environmentStatus,
  isValidEnvironment,
  parseTime,
  dayKeyOf,
  intervalsOverlap,
  normalizeScheduleItem,
  validateBatchSchedule
};
