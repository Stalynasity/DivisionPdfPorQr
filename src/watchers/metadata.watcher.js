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
    ignoreInitial: true,
    depth: 0,
    usePolling: true,      // <--- OBLIGA a revisar aunque Windows no avise
    interval: 500,         // Revisa cada medio segundo
    binaryInterval: 1000
});

watcher.on('add', async (filePath) => {
    // CAMBIO: Quitamos la validación estricta de .json por ahora para probar
    console.log(`INFO: Archivo detectado en ruta: ${filePath}`);
    
    const fileName = path.basename(filePath);
    
    // Si quieres procesar todo lo que empiece por "meta_"
    if (fileName.startsWith('meta_')) { 
        console.log(`INFO: [METADATA] Procesando: ${fileName}`);
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