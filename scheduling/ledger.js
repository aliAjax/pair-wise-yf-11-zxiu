"use strict";

// 裱板养护排程 —— 占用账（养护位预约的记账、释放与留档，数据随 db.json 写回）

function makeBookingId() {
  return `booking_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 占用账集合：旧数据没有该集合时补齐（迁移由入口统一处理）
function ensureCollection(db) {
  if (!Array.isArray(db.curingBookings)) db.curingBookings = [];
  return db.curingBookings;
}

// 仍占用养护位的预约：scheduled（已预约未开工）/ started（已开工）
// released（取消或改约释放）、archived（结项留档）不再占用
function activeBookings(db) {
  return ensureCollection(db).filter((booking) => booking.status === "scheduled" || booking.status === "started");
}

function getBooking(db, bookingId) {
  return ensureCollection(db).find((booking) => booking.id === bookingId) || null;
}

function findByDamage(db, damageId) {
  return ensureCollection(db).filter((booking) => booking.damageId === damageId);
}

function activeBookingForDamage(db, damageId) {
  return activeBookings(db).find((booking) => booking.damageId === damageId) || null;
}

// 登记一笔养护位预约
function reserve(db, item, { batchId, status = "scheduled" }) {
  const bookings = ensureCollection(db);
  const now = new Date().toISOString();
  const booking = {
    id: makeBookingId(),
    batchId,
    damageId: item.damageId,
    rubbingId: item.rubbingId,
    slot: String(item.slot).trim(),
    startAt: item.startAt,
    endAt: item.endAt,
    temperature: Number(item.temperature),
    humidity: Number(item.humidity),
    status, // scheduled / started / released / archived
    history: [{ at: now, action: "reserved" }],
    createdAt: now,
    startedAt: null,
    releasedAt: null,
    archivedAt: null,
    releaseReason: null
  };
  bookings.push(booking);
  return booking;
}

function markStarted(db, booking, at = new Date().toISOString()) {
  booking.status = "started";
  booking.startedAt = at;
  booking.history.push({ at, action: "started" });
}

// 释放养护位：取消（cancel）或开工后改约（changed_after_start）；记录保留可追溯
function release(db, booking, reason, at = new Date().toISOString()) {
  booking.status = "released";
  booking.releasedAt = at;
  booking.releaseReason = reason;
  booking.history.push({ at, action: "released", reason });
}

// 结项留档：占用结束但账目永久保留
function archive(db, booking, at = new Date().toISOString()) {
  booking.status = "archived";
  booking.archivedAt = at;
  booking.history.push({ at, action: "archived" });
}

module.exports = {
  ensureCollection,
  activeBookings,
  getBooking,
  findByDamage,
  activeBookingForDamage,
  reserve,
  markStarted,
  release,
  archive
};
