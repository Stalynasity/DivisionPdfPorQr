import { Worker } from "bullmq";
import { connection } from "../config/redis.js";
import { processPdfSplit } from "../services/split.service.js";
import { downloadFromDrive, moveFile, getOrCreateFolderPath } from "../services/drive.service.js";
import { SYSTEM_FOLDERS } from "../config/tenants.js";
import { getDataFromExcel, updateSheetRow } from "../services/excel.service.js";
import fs from "fs-extra";
import dotenv from "dotenv";
import path from "path";

dotenv.config();

const processor = async (job) => {
    const { fileId, fileName, idCaratula } = job.data;
    const logId = `TICKET:${job.id} | ID:${idCaratula}`;
    let pdfLocalPath = null;

    try {
        console.log(`INFO: WORKER_START - ${logId} | File: ${fileName}`);

        const excelMetadata = await getDataFromExcel(idCaratula);

        if (!excelMetadata) {
            console.warn(`WARN: DATA_MISSING - ${logId} | ID no encontrado en Maestro`);
            await moveFile(fileId, SYSTEM_FOLDERS.ERRORES);
            return { status: 'error_not_found_in_excel' };
        }

        await updateSheetRow(excelMetadata.rowNumber, "maestro", "Estado_Carga", "Separación en curso...");

        const usuario_carga = excelMetadata.Usuario || "SIN_USUARIO";
        const identificacion = excelMetadata.No_Identificacion || "0000000000";
        const proceso = excelMetadata.Proceso || "GENERAL";
        const rootDigitalizados = process.env.ID_CARPETA_DIGITALIZADOS;

        const targetDriveFolderId = await getOrCreateFolderPath(rootDigitalizados, [
            usuario_carga,
            identificacion,
            proceso
        ]);

        pdfLocalPath = await downloadFromDrive(fileId, job.id);
        if (!fs.existsSync(pdfLocalPath)) throw new Error("FILE_NOT_FOUND_AFTER_DOWNLOAD");

        const resultMetadata = await processPdfSplit(
            pdfLocalPath,
            job.id,
            targetDriveFolderId,
            excelMetadata
        );

        // const jsonFileName = `meta_${idCaratula}_${job.id}.json`;
        // const jsonPath = path.join(process.env.Local_metadata, jsonFileName);

        // await fs.writeJson(jsonPath, {
        //     jobId: job.id,
        //     timestamp: new Date().toISOString(),
        //     originalFileName: fileName,
        //     resultMetadata,
        //     clienteData: excelMetadata
        // }, { spaces: 2 });


        // 1. Obtener y validar el directorio (si no existe en .env, usa 'metadata' por defecto)
        const metadataDir = path.resolve(process.env.Local_metadata || "metadata");

        // 2. ASEGURAR que la carpeta existe (fs-extra lo hace por ti)
        await fs.ensureDir(metadataDir);

        // 3. NORMALIZAR el nombre del archivo (Quita espacios, tildes y caracteres raros)
        // Esto evita el error de "Actualizaci贸n"
        const safeIdCaratula = idCaratula.replace(/[^a-z0-9]/gi, '_');
        const jsonFileName = `meta_${safeIdCaratula}_${job.id}.json`;
        const jsonPath = path.join(metadataDir, jsonFileName);

        try {
            // 4. Escribir el archivo
            await fs.writeJson(jsonPath, {
                jobId: job.id,
                timestamp: new Date().toISOString(),
                originalFileName: fileName,
                resultMetadata,
                clienteData: excelMetadata
            }, { spaces: 2 });

        } catch (writeErr) {
            console.error(`ERROR: WRITE_JSON_FAILED - ${logId} | Reason: ${writeErr.message}`);
            // No lanzamos el error aquí para que el PDF no se pierda solo porque falló el JSON
        }



        await updateSheetRow(excelMetadata.rowNumber, "maestro", "Estado_Carga", `FINALIZADO | Ticket: tic-${job.id}`);
        await updateSheetRow(excelMetadata.rowNumber, "monitoreo", "Ticket_procesados", job.id);

        await moveFile(fileId, SYSTEM_FOLDERS.PROCESADOS);

        const duration = ((Date.now() - job.timestamp) / 1000).toFixed(2);
        console.log(`INFO: WORKER_SUCCESS - ${logId} | Time: ${duration}s | Meta: ${jsonFileName}`);

        return { status: 'success', path: jsonPath };

    } catch (err) {
        console.error(`ERROR: WORKER_FAILED - ${logId} | Msg: ${err.message}`);
        try {
            await moveFile(fileId, SYSTEM_FOLDERS.ERRORES);
        } catch (moveErr) {
            console.error(`CRITICAL: RECOVERY_FAILED - ${logId} | No se pudo mover a ERRORES: ${moveErr.message}`);
        }
        throw err;
    }
};

const worker = new Worker("splitQueue", processor, {
    connection,
    concurrency: 3,
    lockDuration: 900000,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 }
});

// --- MANEJO DE EVENTOS ---
worker.on('failed', (job, err) => {
    console.error(`ERROR: JOB_TERMINATED - Ticket: ${job?.id} | Failure: ${err.message}`);
});

worker.on('error', err => {
    console.error(`CRITICAL: REDIS_CONNECTION_LOST - ${err.message}`);
});

// --- LÓGICA DE CIERRE GRACIOSO (Graceful Shutdown) ---
const gracefulShutdown = async (signal) => {
    console.log(`\n INFO: ${signal} recibido. Cerrando worker de forma segura...`);

    // El método close() espera a que los jobs actuales terminen (o lleguen al timeout)
    await worker.close();

    console.log(" Worker cerrado. Proceso finalizado.");
    process.exit(0);
};

// Capturar señales de PM2, Docker o sistema operativo
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
