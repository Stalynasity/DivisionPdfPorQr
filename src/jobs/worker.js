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
    // CAMBIO: Ahora recibimos 'filePath' en lugar de 'fileId'
    const { filePath, fileName, idCaratula } = job.data;
    const logId = `TICKET:${job.id} | ID:${idCaratula}`;

    try {
        console.log(`INFO: WORKER_START - ${logId} | File: ${fileName}`);

        // 1. Validar metadata en Excel
        const excelMetadata = await getDataFromExcel(idCaratula);

        if (!excelMetadata) {
            console.warn(`WARN: DATA_MISSING - ${logId} | ID no encontrado en Maestro`);
            // SI FALLA: Subimos el archivo local a la carpeta de ERRORES de Drive
            const fileBuffer = await fs.readFile(filePath);
            await uploadToDrive(fileName, fileBuffer, SYSTEM_FOLDERS.ERRORES);
            await fs.remove(filePath); // Limpiar local
            return { status: 'error_not_found_in_excel' };
        }

        await updateSheetRow(excelMetadata.rowNumber, "maestro", "Estado_Carga", "Separación en curso...");

        // 2. Preparar carpetas de destino en Drive para los PDFs ya divididos
        const rootDigitalizados = process.env.ID_CARPETA_DIGITALIZADOS;
        const targetDriveFolderId = await getOrCreateFolderPath(rootDigitalizados, [
            excelMetadata.Usuario || "SIN_USUARIO",
            excelMetadata.No_Identificacion || "0000000000",
            excelMetadata.Proceso || "GENERAL"
        ]);

        // 3. VALIDACIÓN: Verificar que el archivo realmente existe en el disco
        if (!await fs.pathExists(filePath)) {
            throw new Error(`FILE_NOT_FOUND_ON_DISK: ${filePath}`);
        }

        // 4. PROCESAR: split.service debe estar preparado para recibir una ruta local
        const resultMetadata = await processPdfSplit(
            filePath, // Ruta local directamente
            job.id,
            targetDriveFolderId,
            excelMetadata
        );

        // 5. GUARDAR METADATA JSON LOCAL
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

        // 6. ACTUALIZAR EXCEL Y LIMPIEZA
        await updateSheetRow(excelMetadata.rowNumber, "maestro", "Estado_Carga", `FINALIZADO EXITOSA | Ticket: tic-${job.id}`);
        await updateSheetRow(2, "monitoreo", "Ticket_procesados", job.id);

        // ELIMINAR EL ARCHIVO LOCAL (Ya se procesó y se subieron las partes a Drive)
        await fs.remove(filePath);

        const duration = ((Date.now() - job.timestamp) / 1000).toFixed(2);
        console.log(`INFO: WORKER_SUCCESS - ${logId} | Time: ${duration}s`);

        return { status: 'success', path: jsonPath };

    } catch (err) {
        console.error(`ERROR: WORKER_FAILED - ${logId} | Msg: ${err.message}`);
        try {
            // Si algo falla catastróficamente, intentamos subir el original a Drive Errores
            if (await fs.pathExists(filePath)) {
                const fileBuffer = await fs.readFile(filePath);
                await uploadToDrive(fileName, fileBuffer, SYSTEM_FOLDERS.ERRORES);
                await fs.remove(filePath);
            }
        } catch (moveErr) {
            console.error(`CRITICAL: RECOVERY_FAILED - No se pudo respaldar en Drive: ${moveErr.message}`);
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

// --- LÓGICA DE CIERRE
const gracefulShutdown = async (signal) => {
    // El método close() espera a que los jobs actuales terminen (o lleguen al timeout)
    await worker.close();

    console.log(" Worker cerrado. Proceso finalizado.");
    process.exit(0);
};

// Capturar señales de PM2, Docker o sistema operativo
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
