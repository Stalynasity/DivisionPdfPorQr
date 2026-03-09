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
    const { fileId, fileName, idCaratula, tenant } = job.data;
    const logPrefix = `[📦 JOB:${job.id}][🆔:${idCaratula}]`;
    let pdfLocalPath = null;

    console.log(`${logPrefix} >>> Iniciando Worker para [${tenant.toUpperCase()}]`);

    try {
        // --- DATA RETRIEVAL ---
        console.log(`${logPrefix} 🔎 Buscando metadatos en Excel...`);
        const excelMetadata = await getDataFromExcel(idCaratula);

        if (!excelMetadata) {
            console.warn(`${logPrefix} ⚠️ ID no encontrado en el maestro. Moviendo a carpeta de errores.`);
            await moveFile(fileId, SYSTEM_FOLDERS.ERRORES);
            return { status: 'error_not_found_in_excel' };
        }

        // --- UPDATE STATUS ---
        await updateSheetRow(excelMetadata.rowNumber, "maestro", "Estado_Carga", "Proceso interno: Iniciando separación");

        // --- ESTRUCTURA DRIVE ---
        const usuario_carga = excelMetadata.Usuario || "SIN_USUARIO";
        const identificacion = excelMetadata.No_Identificacion || "0000000000";
        const proceso = excelMetadata.Proceso || "GENERAL";
        const rootDigitalizados = process.env.ID_CARPETA_DIGITALIZADOS;

        console.log(`${logPrefix} 📁 Estructurando carpetas: ${usuario_carga}/${identificacion}/${proceso}`);

        const targetDriveFolderId = await getOrCreateFolderPath(rootDigitalizados, [
            usuario_carga,
            identificacion,
            proceso
        ]);

        // --- DOWNLOAD ---
        console.log(`${logPrefix} 📥 Descargando PDF de Drive...`);
        pdfLocalPath = await downloadFromDrive(fileId, job.id);

        // Verificación de existencia de archivo descargado
        if (!fs.existsSync(pdfLocalPath)) throw new Error("Fallo la descarga: El archivo local no existe.");

        // --- CORE PROCESS (SPLIT) ---
        const resultMetadata = await processPdfSplit(
            pdfLocalPath,
            tenant,
            job.id,
            targetDriveFolderId,
            excelMetadata
        );

        // --- METADATA JSON ---
        const jsonFileName = `meta_${idCaratula}_${job.id}.json`;
        const jsonPath = path.join(process.env.Local_metadata, jsonFileName);

        const finalData = {
            jobId: job.id,
            tenant,
            timestamp: new Date().toISOString(),
            originalFileName: fileName,
            resultMetadata,
            clienteData: excelMetadata
        };

        await fs.writeJson(jsonPath, finalData, { spaces: 2 });
        console.log(`${logPrefix} 📄 JSON de metadata generado: ${jsonFileName}`);

        // --- FINALIZACIÓN ---
        await updateSheetRow(excelMetadata.rowNumber, "maestro", "Estado_Carga", "FINALIZACION EXITOSA" + ` | Ticket:  tic-${job.id}`);
        await updateSheetRow(excelMetadata.rowNumber, "monitoreo", "Ticket_procesados", job.id);

        await moveFile(fileId, SYSTEM_FOLDERS.PROCESADOS);

        const totalTime = ((Date.now() - job.timestamp) / 1000).toFixed(2);
        console.log(`${logPrefix} ✅ ¡ÉXITO! Job completado en ${totalTime}s\n`);

        return { status: 'success', path: jsonPath };

    } catch (err) {
        console.error(`${logPrefix}  ERROR CRÍTICO: ${err.message}`);

        // Intentar mover a errores solo si tenemos el fileId
        try {
            await moveFile(fileId, SYSTEM_FOLDERS.ERRORES);
            console.log(`${logPrefix} 📂 Archivo original movido a ERRORES.`);
        } catch (moveErr) {
            console.error(`${logPrefix} [FATAL] No se pudo mover el archivo a ERRORES: ${moveErr.message}`);
        }

        throw err; // Importante para que BullMQ gestione el reintento si es necesario
    }
};

const worker = new Worker("splitQueue", processor, {
    connection,
    concurrency: 3, // Procesar uno por uno evita problemas de timeout
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