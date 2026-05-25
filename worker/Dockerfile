FROM node:18-alpine

WORKDIR /app

# Copiar todo el monorepo
COPY package*.json ./
RUN npm ci --production=false

# Instalar Playwright
RUN npx playwright install chromium --with-deps

# Copiar el código fuente completo
COPY . .

# Generar Prisma client
RUN npx prisma generate

# Arrancar el worker desde la raíz del monorepo
CMD ["npx", "tsx", "worker/src/index.ts"]
