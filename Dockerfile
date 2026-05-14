FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Copiar todo el código primero (necesario para prisma generate en postinstall)
COPY . .

# Instalar dependencias
RUN npm ci --production=false

# Build Next.js
RUN npm run build

# Exponer puerto
EXPOSE 3000

# Correr Next.js y el worker en paralelo
CMD ["sh", "-c", "npx tsx worker/src/index.ts & npm start"]
