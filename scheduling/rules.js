"use strict";

// 裱板养护排程 —— 判定层（纯函数，只做规则判定，不读写数据）

const TEMP_RANGE = { min: 18, max: 26 }; // 摄氏度，闭区间
const HUMIDITY_RANGE = { min: 40, max: 60 }; // 相对湿度百分比，闭区间
const DAILY_LIMIT_PER_RUBBING = 2; // 同一拓片当天最多上两块养护位

// 兼容无时区写法，只要能取到年月日墙面时间即可
const ISO_WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?/;

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// 环境值是否在允许区间内
function envInRange(temperature, humidity) {
  return (
    isNumber(temperature) &&
    isNumber(humidity) &&
    temperature >= TEMP_RANGE.min &&
    temperature <= TEMP_RANGE.max &&
    humidity >= HUMIDITY_RANGE.min &&
    humidity <= HUMIDITY_RANGE.max
  );
}

// 时刻能否解析，返回毫秒时间戳；不能解析返回 null
function parseTime(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function wallParts(value) {
  if (typeof value !== "string") return null;
  const matched = value.match(ISO_WALL_RE);
  if (!matched) return null;
  return {
    y: Number(matched[1]),
    m: Number(matched[2]),
    d: Number(matched[3]),
    h: Number(matched[4]),
    min: Number(matched[5]),
    s: Number(matched[6] || 0)
  };
}

// 按字面日期取“当天”键，避免 UTC 换算把本地凌晨算到前一天
function dayKey(value) {
  const p = wallParts(value);
  if (!p) return null;
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

function shiftDayKey(key, delta) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + delta));
  return date.toISOString().slice(0, 10);
}

// 预约覆盖到的自然日（结束时刻恰为 00:00 则不覆盖当天）
function coveredDays(startAt, endAt) {
  const start = dayKey(startAt);
  const endParts = wallParts(endAt);
  if (!start || !endParts) return [];
  let end = dayKey(endAt);
  if (endParts.h === 0 && endParts.min === 0 && endParts.s === 0) end = shiftDayKey(end, -1);
  const days = [];
  let cursor = start;
  for (let i = 0; i < 60 && cursor <= end; i += 1) {
    days.push(cursor);
    if (cursor === end) break;
    cursor = shiftDayKey(cursor, 1);
  }
  return days;
}

// 半开区间 [start, end) 交叉即冲突
function overlaps(a, b) {
  return parseTime(a.startAt) < parseTime(b.endAt) && parseTime(b.startAt) < parseTime(a.endAt);
}

// 结构与取值校验（属于 400 类错误，调用方决定如何返回）
function validateItemShape(item) {
  const errors = [];
  const fields = ["slot", "startAt", "endAt", "temperature", "humidity"];
  for (const field of fields) {
    if (item[field] === undefined || item[field] === null || item[field] === "") {
      errors.push({ field, reason: "missing" });
    }
  }
  if (errors.length) return errors;
  if (typeof item.slot !== "string" || !item.slot.trim()) errors.push({ field: "slot", reason: "invalid" });
  if (!isNumber(item.temperature)) errors.push({ field: "temperature", reason: "not_number" });
  if (!isNumber(item.humidity)) errors.push({ field: "humidity", reason: "not_number" });
  const startMs = parseTime(item.startAt);
  const endMs = parseTime(item.endAt);
  if (startMs === null || !dayKey(item.startAt)) errors.push({ field: "startAt", reason: "invalid_time" });
  if (endMs === null || !dayKey(item.endAt)) errors.push({ field: "endAt", reason: "invalid_time" });
  if (startMs !== null && endMs !== null && startMs >= endMs) errors.push({ field: "endAt", reason: "not_after_start" });
  return errors;
}

// 判定一批预约是否与规则冲突
// items: [{ damageId, rubbingId, slot, startAt, endAt, temperature, humidity }]
// activeBookings: 占用账中仍在占用养护位的记录（scheduled / started）
function evaluateConflicts(items, activeBookings) {
  const conflicts = [];

  // 1. 环境值超出 18~26°C / 40~60%
  for (const item of items) {
    if (!envInRange(item.temperature, item.humidity)) {
      conflicts.push({
        code: "env_out_of_range",
        damageId: item.damageId,
        temperature: item.temperature,
        humidity: item.humidity,
        allowed: { temperature: TEMP_RANGE, humidity: HUMIDITY_RANGE }
      });
    }
  }

  // 2a. 同养护位时段交叉 —— 本批内部
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (items[i].slot === items[j].slot && overlaps(items[i], items[j])) {
        conflicts.push({
          code: "slot_overlap",
          slot: items[i].slot,
          damageIds: [items[i].damageId, items[j].damageId],
          interval: { startAt: items[i].startAt, endAt: items[i].endAt },
          with: { startAt: items[j].startAt, endAt: items[j].endAt },
          existing: false
        });
      }
    }
  }

  // 2b. 同养护位时段交叉 —— 对占用账中已存在的预约
  for (const item of items) {
    for (const booking of activeBookings) {
      if (booking.damageId === item.damageId) continue; // 改约时排除自身
      if (booking.slot === item.slot && overlaps(booking, item)) {
        conflicts.push({
          code: "slot_overlap",
          slot: item.slot,
          damageIds: [item.damageId, booking.damageId],
          interval: { startAt: item.startAt, endAt: item.endAt },
          with: { startAt: booking.startAt, endAt: booking.endAt },
          existing: true
        });
      }
    }
  }

  // 3. 同一拓片当天超过两块：按每笔预约覆盖到的自然日逐日统计
  const dayGroups = new Map();
  const groupKey = (rubbingId, day) => `${rubbingId}|${day}`;
  const addGroup = (rubbingId, day) => {
    const key = groupKey(rubbingId, day);
    if (!dayGroups.has(key)) dayGroups.set(key, { rubbingId, day, fresh: new Set(), existing: new Set() });
    return dayGroups.get(key);
  };
  for (const item of items) {
    for (const day of coveredDays(item.startAt, item.endAt)) {
      addGroup(item.rubbingId, day).fresh.add(item.damageId);
    }
  }
  for (const booking of activeBookings) {
    for (const day of coveredDays(booking.startAt, booking.endAt)) {
      const group = dayGroups.get(groupKey(booking.rubbingId, day));
      if (group && !group.fresh.has(booking.damageId)) group.existing.add(booking.damageId);
    }
  }
  for (const group of dayGroups.values()) {
    const freshIds = [...group.fresh];
    const existingIds = [...group.existing];
    const total = freshIds.length + existingIds.length;
    if (total > DAILY_LIMIT_PER_RUBBING) {
      conflicts.push({
        code: "daily_limit",
        rubbingId: group.rubbingId,
        day: group.day,
        limit: DAILY_LIMIT_PER_RUBBING,
        count: total,
        damageIds: [...freshIds, ...existingIds]
      });
    }
  }

  return conflicts;
}

// 开工后被改动的预约字段
const MAINTENANCE_FIELDS = ["slot", "startAt", "endAt", "temperature", "humidity"];

function changedFields(current, patch) {
  const changed = {};
  for (const field of MAINTENANCE_FIELDS) {
    if (patch[field] === undefined) continue;
    let next = patch[field];
    if (field === "slot") next = String(next).trim();
    if (field === "temperature" || field === "humidity") next = Number(next);
    if (current[field] !== next) changed[field] = next;
  }
  return changed;
}

module.exports = {
  TEMP_RANGE,
  HUMIDITY_RANGE,
  DAILY_LIMIT_PER_RUBBING,
  MAINTENANCE_FIELDS,
  isNumber,
  envInRange,
  parseTime,
  dayKey,
  coveredDays,
  overlaps,
  validateItemShape,
  evaluateConflicts,
  changedFields
};
