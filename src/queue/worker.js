import { Worker } from "bullmq";
import { connection } from "../config/redis.js";
import { processPdfSplit } from "../services/split.service.js";
import { downloadFromDrive, moveFile } from "../services/drive.service.js";
import { SYSTEM_FOLDERS } from "../config/tenants.js";

const processor = async (job) => {
    const { fileId, fileName } = job.data;
    console.log(`[JOB ${job.id}] Procesando archivo: ${fileName}`);
    let pdfLocalPath = null;

    try {
        // 1. Descargar
        pdfLocalPath = await downloadFromDrive(fileId);

        // 2. Procesar división
        // Pasamos "produccion" como tenant por defecto si no viene en el job
        await processPdfSplit(pdfLocalPath, job.data.tenant || "produccion");

        // 3. ÉXITO: Mover de Tránsito a Procesados
        console.log(`[JOB ${job.id}] Finalizado. Moviendo a PROCESADOS...`);
        await moveFile(fileId, SYSTEM_FOLDERS.PROCESADOS);

    } catch (err) {
        console.error(`[ERROR JOB ${job.id}]:`, err.message);

        // 4. ERROR: Mover de Tránsito a Errores
        try {
            await moveFile(fileId, SYSTEM_FOLDERS.ERRORES);
            console.log(`[JOB ${job.id}] Archivo original movido a ERRORES.`);
        } catch (moveErr) {
            console.error("Error crítico: No se pudo sacar el archivo de tránsito", moveErr.message);
        }
        throw err; 
    }
};

const worker = new Worker("splitQueue", processor, { 
    connection, 
    concurrency: 3, // Procesar uno por uno evita problemas de timeout
    lockDuration: 900000, // 15 minutos
    removeOnComplete: { count: 100 }, // Limpia jobs viejos
    removeOnFail: { count: 50 }
});

worker.on('failed', (job, err) => {
    console.error(`[CRÍTICO] Job ${job.id} falló definitivamente: ${err.message}`);
});

worker.on('error', err => {
    console.error(`[REDIS ERROR]: ${err.message}`);
});
// new Worker("splitQueue", processor, { connection, concurrency: 2 });