const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");
const scheduling = require("./scheduling");

const PORT = Number(process.env.PORT || 3020);
const DB_FILE = path.join(__dirname, "data", "db.json");

const initialData = {
  rubbings: [
    {
      id: "rubbing_demo",
      code: "TP-清-014",
      source: "地方碑刻残页",
      paperSize: "42x68cm",
      note: "边缘有旧折痕",
      createdAt: new Date().toISOString()
    }
  ],
  damages: [
    {
      id: "damage_demo_1",
      rubbingId: "rubbing_demo",
      position: "左上角第3列题字旁",
      type: "虫蛀孔",
      beforePhotoUrl: "https://example.local/before-014-1.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    },
    {
      id: "damage_demo_2",
      rubbingId: "rubbing_demo",
      position: "下边缘中央",
      type: "撕裂",
      beforePhotoUrl: "https://example.local/before-014-2.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    }
  ],
  batches: []
};

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=&envVerified=",
  "PATCH /damages/:id",
  "POST /damages/:id/verify-env",
  "POST /damages/:id/reschedule",
  "GET /curing/bookings?status=&slot=",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/start",
  "POST /batches/:id/cancel",
  "POST /batches/:id/complete"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  // 旧数据迁移（旧缺损缺环境值 → 待核验），有改动时写回现有数据文件
  if (scheduling.migrate(db)) await writeDb(db);
  return db;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) {
    const error = new Error("拓片不存在");
    error.status = 404;
    throw error;
  }
  return rubbing;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => !["repaired", "cancelled"].includes(item.status)).length
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/rubbings") {
    const body = await parseBody(req);
    required(body, ["code", "source", "paperSize"]);
    const rubbing = {
      id: makeId("rubbing"),
      code: body.code,
      source: body.source,
      paperSize: body.paperSize,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.rubbings.push(rubbing);
    await writeDb(db);
    return send(res, 201, { data: rubbing });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    const damage = {
      id: makeId("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      // 新登记缺损自带档案，不属“旧缺损待核验”；养护信息在占用时写入
      envVerified: true,
      envBaseline: null,
      curing: null,
      reviewNote: "",
      createdAt: new Date().toISOString(),
      repairedAt: null
    };
    db.damages.push(damage);
    await writeDb(db);
    return send(res, 201, { data: damage });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const envVerifiedParam = url.searchParams.get("envVerified");
    let envVerified;
    if (envVerifiedParam === "true") envVerified = true;
    if (envVerifiedParam === "false") envVerified = false;
    const data = db.damages.filter(
      (item) =>
        (!status || item.status === status) &&
        (!type || item.type === type) &&
        (envVerified === undefined || item.envVerified === envVerified)
    );
    return send(res, 200, { data });
  }

  const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damagePatchMatch && req.method === "PATCH") {
    const body = await parseBody(req);
    // 改约/改环境值的联动（开工后改动回待复核并释放养护位）在服务入口内处理
    const damage = scheduling.patchDamage(db, damagePatchMatch[1], body);
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  const verifyEnvMatch = pathname.match(/^\/damages\/([^/]+)\/verify-env$/);
  if (verifyEnvMatch && req.method === "POST") {
    const body = await parseBody(req);
    const damage = scheduling.verifyEnv(db, verifyEnvMatch[1], body);
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  const rescheduleMatch = pathname.match(/^\/damages\/([^/]+)\/reschedule$/);
  if (rescheduleMatch && req.method === "POST") {
    const body = await parseBody(req);
    const damage = scheduling.rescheduleDamage(db, rescheduleMatch[1], body);
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  if (req.method === "GET" && pathname === "/curing/bookings") {
    const status = url.searchParams.get("status");
    const slot = url.searchParams.get("slot");
    const data = db.curingBookings.filter(
      (booking) => (!status || booking.status === status) && (!slot || booking.slot === slot)
    );
    return send(res, 200, { data });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => scheduling.enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    // 判定不通过时服务抛 409，此处不会执行 writeDb，整批不写入
    const batch = scheduling.createBatch(db, body);
    await writeDb(db);
    return send(res, 201, { data: scheduling.enrichBatch(db, batch) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = db.batches.find((item) => item.id === batchMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    return send(res, 200, { data: scheduling.enrichBatch(db, batch) });
  }

  const startMatch = pathname.match(/^\/batches\/([^/]+)\/start$/);
  if (startMatch && req.method === "POST") {
    const body = await parseBody(req);
    const batch = scheduling.startBatch(db, startMatch[1], body);
    await writeDb(db);
    return send(res, 200, { data: scheduling.enrichBatch(db, batch) });
  }

  const cancelMatch = pathname.match(/^\/batches\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const body = await parseBody(req);
    const batch = scheduling.cancelBatch(db, cancelMatch[1], body);
    await writeDb(db);
    return send(res, 200, { data: scheduling.enrichBatch(db, batch) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const body = await parseBody(req);
    const batch = scheduling.completeBatch(db, completeMatch[1], body);
    await writeDb(db);
    return send(res, 200, { data: scheduling.enrichBatch(db, batch) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) =>
    send(res, error.status || 500, {
      error: error.message || "服务器错误",
      ...(error.reason ? { reason: error.reason } : {}),
      ...(error.currentStatus ? { currentStatus: error.currentStatus } : {}),
      ...(error.conflicts ? { conflicts: error.conflicts } : {}),
      ...(error.details ? { details: error.details } : {})
    })
  );
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});
