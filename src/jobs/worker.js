import { Worker } from "bullmq";
import { connection } from "../config/redis.js";
import { processPdfSplit } from "../services/split.service.js";
import { getOrCreateFolderPath, uploadToDrive } from "../services/drive.service.js";
import { SYSTEM_FOLDERS } from "../config/tenants.js";
import { enqueueStatusUpdate } from "../services/excel.service.js"; // <--- Usamos el nuevo buffer
import fs from "fs-extra";
import dotenv from "dotenv";
import path from "path";

dotenv.config();

// ========================================================
// 1. FUNCIONES AUXILIARES (Single Responsibility Principle)
// ========================================================

const handleFatalError = async (filePath, fileName, errorMsg) => {
    try {
        if (await fs.pathExists(filePath)) {
            const fileBuffer = await fs.readFile(filePath);
            await uploadToDrive(fileName, fileBuffer, SYSTEM_FOLDERS.ERRORES);
            await fs.remove(filePath);
        }
    } catch (e) {
        console.error(`[FATAL] RECOVERY_FAILED - No se pudo mover a Drive Errores: ${e.message}`);
    }
};

const saveLocalMetadata = async (idSofex, jobId, fileName, resultMetadata, excelMetadata) => {
    const metadataDir = path.resolve(process.env.Local_metadata || "metadata");
    await fs.ensureDir(metadataDir);
    
    const safeName = idSofex.replace(/[^a-z0-9]/gi, '-');
    const jsonPath = path.join(metadataDir, `meta_${safeName}.json`);
    
    await fs.writeJson(jsonPath, {
        jobId,
        originalFileName: fileName,
        resultMetadata,
        clienteData: excelMetadata
    }, { spaces: 2 });
    
    return jsonPath;
};

// ========================================================
// 2. PROCESADOR PRINCIPAL (Solo Orquestación)
// ========================================================

const processor = async (job) => {
    const { filePath, fileName, idCaratula, excelMetadata } = job.data;
    const logId = `TICKET:${job.id} | ID:${idCaratula}`;
    const maxRetries = job.opts.attempts || 3;
    const isFinalAttempt = (job.attemptsMade + 1) >= maxRetries;

    // FAIL-FAST 1: Disco
    if (!(await fs.pathExists(filePath))) {
        throw new Error(`FILE_NO_ENCONTRADO_EN_DISCO: ${filePath}`);
    }

    // FAIL-FAST 2: Integridad de Datos (No hacemos fetch aquí para ahorrar API)
    if (!excelMetadata) {
        console.warn(`[WARN] DATA_MISSING - ${logId} | Metadata no provista por el monitor.`);
        await handleFatalError(filePath, fileName, "Metadata omitida.");
        return { status: 'skipped_no_metadata' };
    }

    try {
        // A. Preparar Drive
        const rootDigitalizados = process.env.ID_CARPETA_DIGITALIZADOS;
        const targetDriveFolderId = await getOrCreateFolderPath(rootDigitalizados, [
            excelMetadata.Usuario || "SIN_USUARIO",
            excelMetadata.No_Identificacion || "1000000000",
            excelMetadata.Proceso || "GENERAL"
        ]);

        // B. Procesar Split
        console.log(`[INFO] Procesando PDF - ${logId}`);
        const resultMetadata = await processPdfSplit(filePath, job.id, targetDriveFolderId, excelMetadata);

        // C. Guardar JSON
        const ID_caratula_sofex = `CAR_${excelMetadata.ID_Caratula.split('_').pop()}_${job.id}`;
        const jsonPath = await saveLocalMetadata(ID_caratula_sofex, job.id, fileName, resultMetadata, excelMetadata);

        // D. Éxito: Encolar estado (0 Consumo API)
        await enqueueStatusUpdate(excelMetadata.rowNumber, `PROCESO FINALIZADO | ID_SOF: ${ID_caratula_sofex}`);
        await fs.remove(filePath);
        
        console.log(`[SUCCESS] WORKER_SUCCESS - ${logId}`);
        return { status: 'success', path: jsonPath };

    } catch (err) {
        console.error(`[ERROR] WORKER_FAILED - ${logId} | Intento ${job.attemptsMade + 1}/${maxRetries} | Msg: ${err.message}`);

        if (isFinalAttempt) {
            console.log(`[CRITICAL] Intento final fallido para ${logId}.`);
            await handleFatalError(filePath, fileName, err.message);
            await enqueueStatusUpdate(excelMetadata.rowNumber, `Error Definitivo: ${err.message.substring(0, 100)}`);
        } else {
            await enqueueStatusUpdate(excelMetadata.rowNumber, `Reintentando (${job.attemptsMade + 1}/${maxRetries}). Error: ${err.message.substring(0, 50)}`);
        }
        
        throw err;
    }
};

// ========================================================
// 3. CONFIGURACIÓN DEL WORKER
// ========================================================
const worker = new Worker("splitQueue", processor, {
    connection,
    concurrency: 3,
    lockDuration: 900000,
    removeOnComplete: { count: 700 },
    removeOnFail: { count: 100 }
});

worker.on('failed', (job, err) => console.error(`[BULLMQ_FAIL] JOB_TERMINATED - Ticket: ${job?.id} | Failure: ${err.message}`));
worker.on('error', err => console.error(`[CRITICAL] REDIS_CONNECTION_LOST - ${err.message}`));

const gracefulShutdown = async (signal) => {
    console.log(`\n[SHUTDOWN] Recibida señal ${signal}. Cerrando Worker...`);
    try {
        await worker.close();
        console.log("[SHUTDOWN] Worker cerrado limpiamente.");
    } catch (error) {
        console.error(`[SHUTDOWN] Error: ${error.message}`);
    }
    process.exit(0);
};

let isShuttingDown = false;
const handleShutdown = (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    gracefulShutdown(signal);
};

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));