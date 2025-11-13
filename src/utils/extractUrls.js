// src/utils/extractUrls.js

export function extractUrls(message) {
  if (!message || typeof message !== "object") return [];

  const urls = [];

  // --- тело сообщения (mid, text и т.п.) ---
  const body = message.body && typeof message.body === "object"
    ? message.body
    : {};

  // --- 1. attachments: и сверху, и внутри body ---
  const topAttachments = Array.isArray(message.attachments)
    ? message.attachments
    : [];

  const bodyAttachments = Array.isArray(body.attachments)
    ? body.attachments
    : [];

  const attachments = [...topAttachments, ...bodyAttachments];

  for (const att of attachments) {
    if (!att || typeof att !== "object") continue;

    // файлы
    if (att.type === "file" && att.payload) {
      const fileId =
        att.payload.id ??
        att.payload.file_id ??
        att.payload.fileId ??
        null;

      const fileToken =
        att.payload.token ??
        att.payload.file_token ??
        att.payload.fileToken ??
        null;

      if (fileId) {
        urls.push({
          type: "file",
          url: `file:${fileId}`,
          file_id: fileId,
          file_token: fileToken || null,
        });
      }
    }

    // ссылки через attachment (на всякий случай)
    if (att.type === "link" && att.payload?.url) {
      urls.push({
        type: "link",
        url: att.payload.url,
      });
    }
  }

  // --- 2. текстовые ссылки ---
  const text =
    typeof body.text === "string"
      ? body.text
      : typeof message.text === "string"
        ? message.text
        : "";

  const pattern = /(https?:\/\/[^\s]+)/gi;
  const found = text.match(pattern) || [];

  for (const url of found) {
    if (!urls.some((u) => u.url === url)) {
      urls.push({ type: "link", url });
    }
  }

  return urls;
}
