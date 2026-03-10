# Usamos una imagen ligera de Node 20
FROM node:20-bullseye-slim

# Instalamos Poppler (necesario para pdftoppm)
RUN apt-get update && apt-get install -y \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Instalamos PM2 globalmente
RUN npm install pm2 -g

WORKDIR /app

# Instalamos dependencias (optimizando el caché de Docker)
COPY package*.json ./
RUN npm install --production

# Copiamos el código
COPY . .

# Instalamos el rotador de logs de PM2 dentro del contenedor
RUN pm2 install pm2-logrotate && \
    pm2 set pm2-logrotate:max_size 3M && \
    pm2 set pm2-logrotate:retain 30

# Creamos las carpetas necesarias
RUN mkdir -p tmp/pdf tmp/img logs/metadata

EXPOSE 3010

# Iniciamos usando pm2-runtime para que el contenedor no se detenga
CMD ["pm2-runtime", "ecosystem.config.cjs"]