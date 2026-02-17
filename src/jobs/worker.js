import { Worker } from "bullmq";
import { connection } from "../config/redis.js";
import { processPdfSplit } from "../services/split.service.js";
import { downloadFromDrive, moveFile } from "../services/drive.service.js";
import { SYSTEM_FOLDERS } from "../config/tenants.js";
import { getDataFromExcel } from "../services/excel.service.js";
import fs from "fs-extra";
import dotenv from "dotenv";
import path from "path";
dotenv.config();

const processor = async (job) => {
    const { fileId, fileName, idCaratula, tenant } = job.data;
    // Log de depuración para ver qué llegó realmente
    console.log(`[JOB ${job.id}] Datos recibidos:`, job.data);
    let pdfLocalPath = null;

    try {
        const excelMetadata = await getDataFromExcel(idCaratula);

        if (!excelMetadata) {
            console.warn(`[JOB ${job.id}] ID "${idCaratula}" NO encontrado.`);
            await moveFile(fileId, SYSTEM_FOLDERS.ERRORES);
            return;
        }

        pdfLocalPath = await downloadFromDrive(fileId, job.id);

        // 1. Ejecutamos el split y obtenemos la metadata de los archivos subidos
        const resultMetadata = await processPdfSplit(pdfLocalPath, tenant, job.id, idCaratula);

        // 2. GENERAR ARCHIVO JSON PARA PROCESO EXTERNO
        const jsonFileName = `meta_${idCaratula}_${job.id}.json`;
        const jsonPath = path.join(process.env.Local_metadata, jsonFileName);

        const finalData = {
            ...resultMetadata,
            originalFileName: fileName,
            clienteData: excelMetadata // Incluimos lo que venía del Excel
        };

        await fs.writeJson(jsonPath, finalData, { spaces: 2 });
        console.log(`[JSON] Metadata guardada en: ${jsonPath}`);

        // 3. Mover archivo original en Drive a PROCESADOS
        await moveFile(fileId, SYSTEM_FOLDERS.PROCESADOS);
        console.log(`[JOB ${job.id}] Finalizado con éxito.`);

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