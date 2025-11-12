export function extractUrls(message) {
  const urls = [];
  
  // Проверяем вложения в сообщении
  if (message?.attachments && Array.isArray(message.attachments)) {
    message.attachments.forEach(attachment => {
      if (attachment.type === 'file' && attachment.payload?.url) {
        // Добавляем URL файла в список
        urls.push(attachment.payload.url);
      }
    });
  }

  // Также можно обработать обычные текстовые URL
  const textUrlPattern = /(https?:\/\/[^\s]+)/g;  // Паттерн для ссылок
  const foundTextUrls = message.body.match(textUrlPattern) || [];
  urls.push(...foundTextUrls);

  return urls;
}
