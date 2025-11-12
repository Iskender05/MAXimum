export function extractUrls(message) {
  const urls = [];
  
  // Проверяем вложения в сообщении
  if (message?.attachments && Array.isArray(message.attachments)) {
    message.attachments.forEach(attachment => {
      if (attachment.type === 'file' && attachment.payload?.url) {
        // Добавляем URL файла в список с типом "file"
        urls.push({ url: attachment.payload.url, type: 'file' });
      }
    });
  }

  // Также можно обработать обычные текстовые URL
  const textUrlPattern = /(https?:\/\/[^\s]+)/g;  // Паттерн для ссылок
  const foundTextUrls = message.text.match(textUrlPattern) || [];
  foundTextUrls.forEach(url => {
    // Добавляем текстовые ссылки с типом "link"
    urls.push({ url, type: 'link' });
  });

  return urls;
}
