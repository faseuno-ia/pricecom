FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Instalar dependencias
COPY package*.json ./
RUN npm ci --production=false

# Copiar código fuente
COPY . .

# Generar Prisma client
RUN npx prisma generate

# Build Next.js
RUN npm run build

# Exponer puerto
EXPOSE 3000

# Script de inicio que corre Next.js y el worker en paralelo
CMD ["sh", "-c", "npx tsx worker/src/index.ts & npm start"]
