import fs from "fs/promises";
const FILE = "./db.json";

async function load() {
  try {
    const txt = await fs.readFile(FILE, "utf8");
    return txt ? JSON.parse(txt) : {};
  } catch {
    return {};
  }
}

async function save(data) {
  await fs.writeFile(FILE, JSON.stringify(data, null, 2), "utf8");
}

export async function getState() {
  const db = await load();
  if (!db.state) db.state = { last_update_id: 0 };
  return db.state;
}

export async function setLastUpdateId(id) {
  const db = await load();
  db.state = db.state || {};
  if (id > (db.state.last_update_id || 0)) {
    db.state.last_update_id = id;
    await save(db);
  }
}

export async function addAllowedChat(chat) {
  const db = await load();
  db.allowed_chats = db.allowed_chats || {};
  db.allowed_chats[String(chat.id)] = {
    id: chat.id,
    type: chat.type,
    title: chat.title || chat.username || "",
    first_name: chat.first_name || "",
    last_name: chat.last_name || "",
    added_at: Date.now()
  };
  await save(db);
}

export async function getAllowedChatIds(envList = []) {
  const db = await load();
  const set = new Set(envList.map(String));
  if (db.allowed_chats) {
    for (const id of Object.keys(db.allowed_chats)) set.add(id);
  }
  return Array.from(set).map(Number);
}
