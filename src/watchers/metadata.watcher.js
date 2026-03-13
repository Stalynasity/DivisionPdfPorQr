import chokidar from 'chokidar';
import { Queue } from 'bullmq';
import { connection } from '../config/redis.js';
import path from 'path';
import fs from 'fs-extra';

const soapQueue = new Queue("soapQueue", { connection });
const metadataPath = process.env.Local_metadata;

// Validar que la ruta existe antes de empezar
if (!metadataPath) {
    console.error("ERROR: La variable Local_metadata no está definida en el .env");
    process.exit(1);
}

console.log(`INFO: Iniciando Watcher en: ${metadataPath}`);

const watcher = chokidar.watch(metadataPath, {
    ignored: /(^|[\/\\])\../,
    persistent: true,
    ignoreInitial: true, // No procesa archivos viejos al reiniciar
    depth: 0 // Solo vigila la raíz de la carpeta metadata
});

watcher.on('add', async (filePath) => {
    if (path.extname(filePath) === '.json') {
        const fileName = path.basename(filePath);
        console.log(`INFO: [NEW_JSON] Detectado: ${fileName}`);
        
        try {
            // Agregamos a la cola para que el soap.worker.js lo tome
            await soapQueue.add("processSoap", 
                { jsonPath: filePath },
                { 
                    attempts: 3, 
                    backoff: { type: 'exponential', delay: 5000 } 
                }
            );
            console.log(`SUCCESS: [ENQUEUED] ${fileName} enviado a la cola SOAP`);
        } catch (err) {
            console.error(`ERROR: No se pudo encolar ${fileName}: ${err.message}`);
        }
    }
});

watcher.on('error', error => console.error(`WATCHER_ERROR: ${error}`));