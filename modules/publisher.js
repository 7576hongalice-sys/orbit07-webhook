// modules/publisher.js
import fetch from 'node-fetch';
import { Buffer } from 'node:buffer';

export async function publishToGitHub(path, content) {
  const owner = process.env.GH_OWNER;
  const repo  = process.env.GH_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!owner || !repo || !token) throw new Error('Missing GH env');

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  // 先拿 sha（檔案已存在要帶 sha 覆蓋）
  let sha;
  try {
    const meta = await fetch(url, { headers: { Authorization: `Bearer ${token}` }}).then(r=>r.ok?r.json():null);
    sha = meta?.sha;
  } catch {}

  const body = {
    message: `update ${path}`,
    content: Buffer.from(content || '', 'utf8').toString('base64'),
    ...(sha ? { sha } : {})
  };

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub PUT fail: ${res.status} ${t}`);
  }
}
