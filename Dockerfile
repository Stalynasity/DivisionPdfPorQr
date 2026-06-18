# Usamos una imagen ligera de Node 20
FROM node:20-bullseye-slim

# Configurar Zona Horaria Ecuador
ENV TZ=America/Guayaquil
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Instalamos Poppler (necesario para pdftoppm)
RUN apt-get update && apt-get install -y \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Deshabilitamos SSL estricto para NPM (Vital para tu red) - ver
RUN npm config set strict-ssl false

# 2. Instalamos pnpm y PM2 globalmente en un solo paso
RUN npm install -g pnpm pm2

# 3. Aplicamos la misma regla de SSL falso, pero ahora para pnpm
RUN pnpm config set strict-ssl false
# -----------------------

WORKDIR /app

# 3. Copiamos el package.json Y el nuevo pnpm-lock.yaml
COPY package.json pnpm-lock.yaml ./

# 4. Instalamos las dependencias con pnpm (--frozen-lockfile es vital en Docker)
RUN pnpm install --prod --frozen-lockfile

# Copiamos el código
COPY . .

# Instalamos el rotador de logs de PM2
RUN pm2 install pm2-logrotate && \
    pm2 set pm2-logrotate:max_size 150M && \
    pm2 set pm2-logrotate:retain 20 && \
    pm2 set pm2-logrotate:compress true && \
    pm2 kill

# Creamos las carpetas necesarias
RUN mkdir -p tmp/pdf tmp/img logs/metadata

EXPOSE 3010

# El salvavidas de memoria para procesamiento de PDFs pesados
# 1536MB = 1.5GB. Obliga a limpiar basura antes del límite de 2G de PM2.
ENV NODE_OPTIONS="--max-old-space-size=1536"

# Iniciamos usando pm2-runtime para que el contenedor no se detenga
CMD ["pm2-runtime", "ecosystem.config.cjs"]