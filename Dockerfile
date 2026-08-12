FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

# Copiar todo el código primero (necesario para prisma generate en postinstall)
COPY . .

# Instalar dependencias
RUN npm ci --production=false

# Build Next.js
RUN npm run build

# Exponer puerto
EXPOSE 3000

# 2G-R9-PR1 · Servicio WEB (pricecom): SÓLO la app Next. El worker corre en su propio servicio
# (pricecom-worker). Antes este CMD arrancaba además el poll loop del worker como sidecar — residuo de
# la migración incompleta 2026-05-24 que causó el dual-poller (ver docs/worker-topology.md).
# `npm start` = `prisma migrate deploy && next start` (el migrate deploy sigue corriendo en el boot web).
CMD ["npm", "start"]
