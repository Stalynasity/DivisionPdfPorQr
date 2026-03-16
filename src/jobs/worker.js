import { Worker } from "bullmq";
import { connection } from "../config/redis.js";
import { processPdfSplit } from "../services/split.service.js";
import { moveFile, getOrCreateFolderPath, uploadToDrive } from "../services/drive.service.js";
import { SYSTEM_FOLDERS } from "../config/tenants.js";
import { getDataFromExcel, updateSheetRow } from "../services/excel.service.js";
import fs from "fs-extra";
import dotenv from "dotenv";
import path from "path";

dotenv.config();

const processor = async (job) => {
    const { filePath, fileName, idCaratula } = job.data;
    const logId = `TICKET:${job.id} | ID:${idCaratula}`;

    // Declaramos la variable fuera para que sea accesible en el catch
    /** @type {import('../interfaces/excel.interface').ExcelMetadata | null} */
    let excelMetadata = null;

    try {
        console.log(`INFO: WORKER_START - ${logId} | File: ${fileName}`);

        // 1. Validar metadata en Excel (Dentro del try por si falla la red/API)
        excelMetadata = await getDataFromExcel(idCaratula);

        if (!excelMetadata) {
            console.warn(`WARN: DATA_MISSING - ${logId} | ID no encontrado en Maestro`);

            if (await fs.pathExists(filePath)) {
                const fileBuffer = await fs.readFile(filePath);
                await uploadToDrive(fileName, fileBuffer, SYSTEM_FOLDERS.ERRORES);
                await fs.remove(filePath);
            }
            // Retornamos en lugar de lanzar error para que el job se marque como completado (con aviso)
            // o lanza un error si prefieres que BullMQ lo reintente.
            return { status: 'error_not_found_in_excel' };
        }

        // 2. Actualizar estado inicial
        await updateSheetRow(excelMetadata.rowNumber, "maestro", "Estado_Carga", "Separación en curso...");

        // 3. Preparar carpetas de destino
        const rootDigitalizados = process.env.ID_CARPETA_DIGITALIZADOS;
        const targetDriveFolderId = await getOrCreateFolderPath(rootDigitalizados, [
            excelMetadata.Usuario || "SIN_USUARIO",
            excelMetadata.No_Identificacion || "0000000000",
            excelMetadata.Proceso || "GENERAL"
        ]);

        // 4. VALIDACIÓN: Disco
        if (!(await fs.pathExists(filePath))) {
            throw new Error(`FILE_NO_ENCONTRADO_EN_DISCO: ${filePath}`);
        }

        // 5. PROCESAR SPLIT
        const resultMetadata = await processPdfSplit(
            filePath,
            job.id,
            targetDriveFolderId,
            excelMetadata
        );

        // 6. GUARDAR JSON LOCAL
        const metadataDir = path.resolve(process.env.Local_metadata || "metadata");
        await fs.ensureDir(metadataDir);
        const safeIdCaratula = idCaratula.replace(/[^a-z0-9]/gi, '_');
        const jsonPath = path.join(metadataDir, `meta_${safeIdCaratula}_${job.id}.json`);

        await fs.writeJson(jsonPath, {
            jobId: job.id,
            timestamp: new Date().toISOString(),
            originalFileName: fileName,
            resultMetadata,
            clienteData: excelMetadata
        }, { spaces: 2 });

        // 7. FINALIZACIÓN
        await updateSheetRow(excelMetadata.rowNumber, "maestro", "Estado_Carga", `FINALIZADO EXITOSA | Ticket: tic-${job.id}`);
        await updateSheetRow(2, "monitoreo", "Ticket_procesados", job.id);

        await fs.remove(filePath);
        console.log(`INFO: WORKER_SUCCESS - ${logId}`);

        return { status: 'success', path: jsonPath };

    } catch (err) {
        console.error(`ERROR: WORKER_FAILED - ${logId} | Msg: ${err.message}`);

        try {
            if (await fs.pathExists(filePath)) {
                const fileBuffer = await fs.readFile(filePath);
                await uploadToDrive(fileName, fileBuffer, SYSTEM_FOLDERS.ERRORES);

                // Solo intentamos actualizar el Excel si logramos obtener la metadata antes del error
                if (excelMetadata?.rowNumber) {
                    await updateSheetRow(
                        excelMetadata.rowNumber,
                        "maestro",
                        "Estado_Carga",
                        `Error: ${err.message.substring(0, 100)}` // Evitar textos gigantes en Excel
                    );
                }
                await fs.remove(filePath);
            }
        } catch (recoveryErr) {
            console.error(`CRITICAL: RECOVERY_FAILED - ${recoveryErr.message}`);
        }

        // Lanzamos el error para que BullMQ gestione los reintentos
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

// --- LÓGICA DE CIERRE
const gracefulShutdown = async (signal) => {
    await worker.close();

    console.log(" Worker cerrado. Proceso finalizado.");
    process.exit(0);
};

// Capturar señales de PM2, Docker o sistema operativo
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));