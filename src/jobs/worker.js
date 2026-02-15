import { Worker } from "bullmq";
import { connection } from "../config/redis.js";
import { processPdfSplit } from "../services/split.service.js";
import { downloadFromDrive, moveFile } from "../services/drive.service.js";
import { SYSTEM_FOLDERS } from "../config/tenants.js";

const processor = async (job) => {
    const { fileId, fileName } = job.data;
    console.log(`[JOB ${job.id}] Iniciando: ${fileName}`);
    let pdfLocalPath = null;

    try {
        // 1. Descarga con ID de Job
        pdfLocalPath = await downloadFromDrive(fileId, job.id);

        // 2. Procesar división (pasando el jobId para aislamiento)
        console.log(`[JOB ${job.id}] Ruta: ${pdfLocalPath}, Tenant: ${job.data.tenant}`);
        await processPdfSplit(pdfLocalPath, job.data.tenant, job.id);

        // 3. ÉXITO - mueve transito a procesados
        await moveFile(fileId, SYSTEM_FOLDERS.PROCESADOS);
        console.log(`[JOB ${job.id}] Completado y movido a PROCESADOS.`);

    } catch (err) {
        console.error(`[ERROR JOB ${job.id}]:`, err.message);
        try {
            await moveFile(fileId, SYSTEM_FOLDERS.ERRORES);
        } catch (moveErr) {
            console.error(`[CRITICAL] No se pudo mover a ERRORES: ${moveErr.message}`);
        }
        throw err; 
    }
};

const worker = new Worker("splitQueue", processor, { 
    connection, 
    concurrency: 4, // Procesar uno por uno evita problemas de timeout
    lockDuration: 900000, // 15 minutos
    removeOnComplete: { count: 150 }, // Limpia jobs viejos
    removeOnFail: { count: 50 }
});

worker.on('failed', (job, err) => {
    console.error(`[CRÍTICO] Job ${job.id} falló definitivamente: ${err.message}`);
});

worker.on('error', err => {
    console.error(`[REDIS ERROR]: ${err.message}`);
});
// new Worker("splitQueue", processor, { connection, concurrency: 2 });