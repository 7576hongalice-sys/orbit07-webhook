const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");

const {
  mountPremarket,
  runPremarketGate,
} = require("../modules/premarket");

const LABELS = [
  ["加權指數", ["twse_index"]],
  ["櫃買指數", ["tpex_index"]],
  ["三大法人買賣超", ["twse_institution_summary", "tpex_institution_summary"]],
  ["上市外資買賣超排行", ["twse_institution_detail"]],
  ["上市投信買賣超排行", ["twse_institution_detail"]],
  ["上櫃外資買賣超排行", ["tpex_foreign"]],
  ["上櫃投信買賣超排行", ["tpex_trust"]],
];

function statusFixture(date = "2026-09-01") {
  const endpoints = {};
  for (const [, dependencies] of LABELS) {
    for (const dependency of dependencies) endpoints[dependency] = { updated: true };
  }
  return {
    trading_date: date,
    official_only: true,
    completeness: "7/7",
    complete: true,
    items: LABELS.map(([label, dependencies]) => ({ label, updated: true, dependencies })),
    endpoints,
  };
}

function historyFixture(date = "2026-09-01") {
  return {
    schema_version: 2,
    trading_date: date,
    official_only: true,
    completeness: "7/7",
    complete: true,
    checks: Object.fromEntries(LABELS.map(([label]) => [label, true])),
  };
}

function readerFixture(status = statusFixture(), history = historyFixture()) {
  return {
    calls: [],
    async readText(path) {
      this.calls.push(path);
      return JSON.stringify(path.includes("latest/status") ? status : history);
    },
  };
}

const WEDNESDAY_MORNING = new Date("2026-09-01T23:30:00.000Z"); // 2026-09-02 07:30 TPE

test("normal trading day with 7/7 official data passes", async () => {
  const result = await runPremarketGate({ reader: readerFixture(), now: WEDNESDAY_MORNING });
  assert.equal(result.premarket_ready, true);
  assert.equal(result.taiwan_date, "2026-09-02");
  assert.equal(result.previous_trading_date, "2026-09-01");
  assert.deepEqual(Object.values(result.checks), Array(7).fill(true));
});

test("completeness 6/7 fails closed", async () => {
  const status = statusFixture();
  status.completeness = "6/7";
  await assert.rejects(runPremarketGate({ reader: readerFixture(status), now: WEDNESDAY_MORNING }),
    (error) => error.code === "incomplete");
});

test("official_only false fails closed", async () => {
  const status = statusFixture();
  status.official_only = false;
  await assert.rejects(runPremarketGate({ reader: readerFixture(status), now: WEDNESDAY_MORNING }),
    (error) => error.code === "not_official_only");
});

test("trading_date one day late fails closed", async () => {
  const status = statusFixture("2026-09-02");
  await assert.rejects(runPremarketGate({ reader: readerFixture(status), now: WEDNESDAY_MORNING }),
    (error) => error.code === "trading_date_not_previous");
});

test("any item updated false fails closed", async () => {
  const status = statusFixture();
  status.items[4].updated = false;
  await assert.rejects(runPremarketGate({ reader: readerFixture(status), now: WEDNESDAY_MORNING }),
    (error) => error.code === "item_not_updated");
});

test("GitHub read failure fails closed", async () => {
  const reader = { async readText() { throw new Error("network down"); } };
  await assert.rejects(runPremarketGate({ reader, now: WEDNESDAY_MORNING }), /network down/);
});

test("malformed JSON fails closed", async () => {
  const reader = { async readText() { return "{not-json"; } };
  await assert.rejects(runPremarketGate({ reader, now: WEDNESDAY_MORNING }),
    (error) => error.code === "json_parse_error");
});

test("Monday uses Friday as the previous effective trading day", async () => {
  const status = statusFixture("2026-08-28");
  const history = historyFixture("2026-08-28");
  const mondayMorning = new Date("2026-08-30T23:30:00.000Z");
  const result = await runPremarketGate({ reader: readerFixture(status, history), now: mondayMorning });
  assert.equal(result.taiwan_date, "2026-08-31");
  assert.equal(result.previous_trading_date, "2026-08-28");
});

test("first session after a long holiday uses the latest official trading date", async () => {
  const status = statusFixture("2026-09-25");
  const history = historyFixture("2026-09-25");
  const afterHoliday = new Date("2026-09-29T23:30:00.000Z");
  const result = await runPremarketGate({ reader: readerFixture(status, history), now: afterHoliday });
  assert.equal(result.taiwan_date, "2026-09-30");
  assert.equal(result.previous_trading_date, "2026-09-25");
});

async function withTestServer({ reader, afterReady }, callback) {
  const app = express();
  app.use(express.json());
  const requiredKey = "test-cron-key";
  const requireKey = (req, res) => {
    const key = req.headers["x-cron-key"];
    if (key !== requiredKey) {
      res.status(401).json({ premarket_ready: false, reason: "invalid key" });
      return false;
    }
    return true;
  };
  mountPremarket(app, { requireKey, reader, now: () => WEDNESDAY_MORNING, afterReady });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("X-Cron-Key header authenticates the formal endpoint", async () => {
  await withTestServer({ reader: readerFixture() }, async (base) => {
    const response = await fetch(`${base}/cron/premarket`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cron-Key": "test-cron-key" },
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).premarket_ready, true);
  });
});

test("query string key is not accepted for the formal endpoint", async () => {
  await withTestServer({ reader: readerFixture() }, async (base) => {
    const response = await fetch(`${base}/cron/premarket?key=test-cron-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).premarket_ready, false);
  });
});

test("gate failure never invokes post-gate processing", async () => {
  const status = statusFixture();
  status.items[0].updated = false;
  let downstreamCalls = 0;
  await withTestServer({
    reader: readerFixture(status),
    afterReady: async () => { downstreamCalls += 1; },
  }, async (base) => {
    const response = await fetch(`${base}/cron/premarket`, {
      method: "POST",
      headers: { "X-Cron-Key": "test-cron-key" },
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).premarket_ready, false);
  });
  assert.equal(downstreamCalls, 0);
});
