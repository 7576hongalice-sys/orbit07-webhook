// db.js — 極簡 JSON「戀股資料庫」
const fs = require("fs/promises");
const path = require("path");

async function _load(file) {
  try {
    const txt = await fs.readFile(file, "utf8");
    return txt ? JSON.parse(txt) : {};
  } catch {
    return {};
  }
}
async function _save(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

async function addInbox(file, ymd, item) {
  const db = await _load(file);
  if (!db[ymd]) db[ymd] = { inbox: [], summary: null };
  db[ymd].inbox.push(item);
  await _save(file, db);
}

async function setSummary(file, ymd, summary) {
  const db = await _load(file);
  if (!db[ymd]) db[ymd] = { inbox: [], summary: null };
  db[ymd].summary = summary;
  await _save(file, db);
}

async function getDay(file, ymd) {
  const db = await _load(file);
  return db[ymd] || { inbox: [], summary: null };
}

module.exports = { addInbox, setSummary, getDay };
