# Usamos una imagen ligera de Node 20
FROM node:20-bullseye-slim

# Instalamos Poppler (necesario para pdftoppm)
RUN apt-get update && apt-get install -y \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Deshabilitamos la verificación estricta de SSL para NPM
RUN npm config set strict-ssl false

# Instalamos PM2 globalmente
RUN npm install pm2 -g

WORKDIR /app

# Instalamos dependencias (optimizando el caché de Docker)
COPY package*.json ./

# Mantenemos el flag de SSL falso para la instalación de dependencias del proyecto
RUN npm install --production

# Copiamos el código
COPY . .

# Instalamos el rotador de logs de PM2
# Nota: pm2 install también usa npm internamente, por lo que heredará la config de SSL
RUN pm2 install pm2-logrotate && \
    pm2 set pm2-logrotate:max_size 150M && \
    pm2 set pm2-logrotate:retain 20

# Creamos las carpetas necesarias
RUN mkdir -p tmp/pdf tmp/img logs/metadata

EXPOSE 3010

# Iniciamos usando pm2-runtime para que el contenedor no se detenga
CMD ["pm2-runtime", "ecosystem.config.cjs"]