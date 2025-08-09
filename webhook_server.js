app.post("/webhook", async (req, res) => {
  const msg = req.body?.message;
  if (!msg) return res.sendStatus(200);

  const chatId = String(msg.chat.id);
  const text = (msg.text || "").trim();

  if (text.startsWith("/")) {
    await handleCommand(chatId, text);
    return res.sendStatus(200);
  }

  await send(chatId, `收到：「${text}」～要我產出盤前/盤後報告嗎？`);
  return res.sendStatus(200);
});
