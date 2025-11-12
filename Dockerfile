# === build ===
FROM node:20-alpine AS build
WORKDIR /app

# Копируем только манифесты. Если на этом шаге упадёт — значит контекст/игнор.
COPY package.json package-lock.json* ./

# Устанавливаем зависимости:
# - если есть lock -> npm ci
# - если нет lock -> npm i
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm i  --omit=dev --no-audit --no-fund; \
    fi

# Копируем остальной код
COPY src ./src

# === runtime ===
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app /app

# Команду задаёт docker-compose (bot/worker)
CMD ["node", "-e", "console.log('Set command in docker-compose.yml')"]
