// 裱板养护排程：占用账模块
// db.curingBookings 为养护位占用账：
//   state: held（占用中：已排程或已开工）/ released（已释放）/ archived（结项留档）
// 缺损项上的 curing 字段是账本的冗余视图，便于列表展示；以账本为准。

const { BadRequestError } = require("./rules");

const HELD_STATES = ["scheduled", "in_repair"];

function makeBookingId() {
  return `curing_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 旧数据迁移：没有 curing 字段的缺损一律视为缺少环境值，待核验
function migrateCuring(db) {
  if (!Array.isArray(db.curingBookings)) db.curingBookings = [];
  let changed = false;
  for (const damage of db.damages) {
    if (damage.curing === undefined) {
      damage.curing = null;
      damage.needsEnvVerification = true;
      if (damage.status === "pending") damage.status = "verification_pending";
      changed = true;
    }
    if (damage.needsEnvVerification === undefined) {
      damage.needsEnvVerification = damage.curing === null;
      changed = true;
    }
  }
  return changed;
}

function heldBookings(db) {
  return (db.curingBookings || []).filter((booking) => booking.state === "held");
}

function findHeldBookingByDamage(db, damageId) {
  return heldBookings(db).find((booking) => booking.damageId === damageId) || null;
}

function syncDamageCuring(db, damage) {
  const booking = findHeldBookingByDamage(db, damage.id);
  if (booking) {
    damage.curing = {
      slotId: booking.slotId,
      startAt: booking.startAt,
      endAt: booking.endAt,
      temperatureC: booking.temperatureC,
      humidityPct: booking.humidityPct,
      bookingId: booking.id,
      state: booking.phase === "started" ? "started" : "booked",
      registeredAt: booking.registeredAt,
      startedAt: booking.startedAt,
      releasedAt: null,
      releaseReason: "",
      reviewNote: ""
    };
  } else if (damage.curing) {
    // 最近一次占用已释放/归档，保留登记值留痕
    damage.curing.bookingId = damage.curing.bookingId || null;
    damage.curing.state = damage.curing.state === "archived" ? "archived" : "released";
  }
}

// 建批通过判定后调用：登记占用
function reserveBookings(db, items, batchId, clock = () => new Date()) {
  const now = clock().toISOString();
  const damagesById = new Map(db.damages.map((damage) => [damage.id, damage]));
  for (const item of items) {
    const damage = damagesById.get(item.damageId);
    const booking = {
      id: makeBookingId(),
      batchId,
      damageId: item.damageId,
      rubbingId: item.rubbingId || damage.rubbingId,
      slotId: item.slotId,
      startAt: item.startAt.toISOString(),
      endAt: item.endAt.toISOString(),
      temperatureC: item.temperatureC,
      humidityPct: item.humidityPct,
      state: "held",
      phase: "booked",
      registeredAt: now,
      startedAt: null,
      releasedAt: null,
      releaseReason: "",
      reviewNote: "",
      archivedAt: null
    };
    db.curingBookings.push(booking);
    damage.batchId = batchId;
    damage.status = "scheduled";
    damage.needsEnvVerification = false;
    syncDamageCuring(db, damage);
  }
}

// 开工：仅未开工的占用预约可开工
function markStarted(db, damageId, clock = () => new Date()) {
  const booking = findHeldBookingByDamage(db, damageId);
  if (!booking) throw new BadRequestError("该缺损没有占用中的养护预约，无法开工");
  if (booking.phase === "started") throw new BadRequestError("该项已开工");
  booking.phase = "started";
  booking.startedAt = clock().toISOString();
  const damage = db.damages.find((item) => item.id === damageId);
  damage.status = "in_repair";
  syncDamageCuring(db, damage);
  return booking;
}

// 释放占用（取消未开工项 / 开工后改预约或环境值回待复核）
function releaseBooking(db, damageId, reason, options = {}, clock = () => new Date()) {
  const booking = findHeldBookingByDamage(db, damageId);
  if (!booking) return null;
  booking.state = "released";
  booking.releasedAt = clock().toISOString();
  booking.releaseReason = reason;
  booking.reviewNote = options.reviewNote || "";

  const damage = db.damages.find((item) => item.id === damageId);
  damage.curing = {
    slotId: options.slotId ?? booking.slotId,
    startAt: options.startAt ?? booking.startAt,
    endAt: options.endAt ?? booking.endAt,
    temperatureC: options.temperatureC ?? booking.temperatureC,
    humidityPct: options.humidityPct ?? booking.humidityPct,
    bookingId: booking.id,
    state: "released",
    registeredAt: booking.registeredAt,
    startedAt: booking.startedAt,
    releasedAt: booking.releasedAt,
    releaseReason: reason,
    reviewNote: options.reviewNote || ""
  };
  return booking;
}

// 改预约/环境值后重新占用（待复核 -> 已排程）
function rebindBooking(db, damageId, item, clock = () => new Date()) {
  const damage = db.damages.find((entry) => entry.id === damageId);
  if (!damage) throw new BadRequestError("缺损项不存在");
  const oldBooking = findHeldBookingByDamage(db, damageId);
  if (oldBooking) {
    oldBooking.state = "released";
    oldBooking.releasedAt = clock().toISOString();
    oldBooking.releaseReason = "reschedule";
  }
  const now = clock().toISOString();
  const booking = {
    id: makeBookingId(),
    batchId: damage.batchId,
    damageId: damage.id,
    rubbingId: damage.rubbingId,
    slotId: item.slotId,
    startAt: item.startAt.toISOString(),
    endAt: item.endAt.toISOString(),
    temperatureC: item.temperatureC,
    humidityPct: item.humidityPct,
    state: "held",
    phase: "booked",
    registeredAt: now,
    startedAt: null,
    releasedAt: null,
    releaseReason: "",
    reviewNote: "",
    archivedAt: null
  };
  db.curingBookings.push(booking);
  damage.status = "scheduled";
  damage.needsEnvVerification = false;
  syncDamageCuring(db, damage);
  return booking;
}

// 取消批次：只释放未开工项；已开工的继续占用
function cancelUnstarted(db, batchId, clock = () => new Date()) {
  const released = [];
  for (const booking of heldBookings(db)) {
    if (booking.batchId !== batchId || booking.phase !== "booked") continue;
    releaseBooking(db, booking.damageId, "batch_cancelled", {}, clock);
    const damage = db.damages.find((item) => item.id === booking.damageId);
    damage.batchId = null;
    damage.status = "pending";
    damage.needsEnvVerification = false;
    released.push(booking.damageId);
  }
  return released;
}

// 结项：该批仍占用的账页留档，不释放
function archiveBatch(db, batchId, clock = () => new Date()) {
  const archived = [];
  const at = clock().toISOString();
  for (const booking of db.curingBookings) {
    if (booking.batchId !== batchId || booking.state !== "held") continue;
    booking.state = "archived";
    booking.archivedAt = at;
    archived.push(booking.damageId);
    const damage = db.damages.find((item) => item.id === booking.damageId);
    if (damage) {
      damage.curing = {
        slotId: booking.slotId,
        startAt: booking.startAt,
        endAt: booking.endAt,
        temperatureC: booking.temperatureC,
        humidityPct: booking.humidityPct,
        bookingId: booking.id,
        state: "archived",
        registeredAt: booking.registeredAt,
        startedAt: booking.startedAt,
        releasedAt: null,
        releaseReason: "",
        reviewNote: "",
        archivedAt: at
      };
    }
  }
  return archived;
}

module.exports = {
  HELD_STATES,
  migrateCuring,
  heldBookings,
  findHeldBookingByDamage,
  syncDamageCuring,
  reserveBookings,
  markStarted,
  releaseBooking,
  rebindBooking,
  cancelUnstarted,
  archiveBatch
};
