import { splitQueue } from "../jobs/queue.js";
import { SYSTEM_FOLDERS, PATHS } from "../config/tenants.js";
import { uploadFileToDrive } from "./drive.service.js";
import { renderPdfToImages } from "./render.service.js";
import { readQR } from "./qr.service.js";
import { getDataFromExcel, enqueueStatusUpdate, getMaintenanceRedis } from "../services/excel.service.js"; // <--- Importamos enqueueStatusUpdate
import fs from "fs-extra";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const RUTA_LOCAL_ENTRADA = process.env.PATH_ENTRADA_LOCAL;
const RUTA_LOCAL_ENCOLADO = process.env.PATH_ENCOLADO_LOCAL;
let isMaintenanceMode = false;

export const setMaintenanceMode = (value) => {
    isMaintenanceMode = value;
    console.log(`[SYSTEM] Modo Mantenimiento: ${value ? 'ACTIVADO' : 'DESACTIVADO'}`);
};

/**
 * Valida si un archivo ya terminó de copiarse en el disco duro.
 */
const isFileStable = async (filePath) => {
    try {
        const stat1 = await fs.stat(filePath);
        await new Promise(resolve => setTimeout(resolve, 500)); // Esperamos medio segundo
        const stat2 = await fs.stat(filePath);

        // Si el tamaño sigue creciendo o está vacío (0 bytes), no está listo
        if (stat1.size !== stat2.size || stat2.size === 0) {
            return false;
        }
        const fd = await fs.open(filePath, 'r+');
        await fs.close(fd);

        return true; // El archivo está estable y libre
    } catch (error) {
        return false; // Está bloqueado, devolvemos falso
    }
};

export const watchInputFolder = async () => {
    const isMaintenance = await getMaintenanceRedis();

    if (isMaintenance) {
        console.log("... [!] Sistema en PAUSA por mantenimiento mensual (Redis) ...");
        return;
    }

    try {
        await fs.ensureDir(RUTA_LOCAL_ENTRADA);
        await fs.ensureDir(RUTA_LOCAL_ENCOLADO);

        const files = await fs.readdir(RUTA_LOCAL_ENTRADA);
        const pdfFiles = files.filter(f => f.toLowerCase().endsWith('.pdf'));

        if (pdfFiles.length === 0) return;

        for (const fileName of pdfFiles) {
            let localPath = path.join(RUTA_LOCAL_ENTRADA, fileName); // Cambiado a 'let' para poder reasignar
            let currentFileName = fileName;

            // --- NUEVA VALIDACIÓN DE ESTABILIDAD ---
            const isStable = await isFileStable(localPath);
            if (!isStable) {
                // No hacemos ruido, solo lo omitimos. En 4 segundos el monitor volverá a intentarlo.
                console.log(`[INFO] Archivo copiándose o bloqueado: ${currentFileName}. Esperando...`);
                continue; 
            }

            let tempImgDir = null;

            // Renombrado (solo se ejecuta si el archivo ya está estable)
            if (currentFileName.length > 100) {
                const ext = path.extname(currentFileName);
                const base = path.basename(currentFileName, ext).substring(0, 50);
                const newFileName = `${base}_${Date.now()}${ext}`;
                const newPath = path.join(RUTA_LOCAL_ENTRADA, newFileName);

                try {
                    await fs.rename(localPath, newPath);
                    currentFileName = newFileName;
                    localPath = newPath;
                } catch (renameErr) {
                    console.error(`No se pudo renombrar: ${renameErr.message}`);
                }
            }

            console.log(`\n---PROCESANDO: ${currentFileName} ---`);

            try {
                if (!await fs.pathExists(localPath)) {
                    throw new Error(`El archivo desapareció antes de procesar: ${localPath}`);
                }

                tempImgDir = path.join(PATHS.tempImg, `scan-${Date.now()}`);
                await fs.ensureDir(tempImgDir);

                console.log(`[1/4] Renderizando PDF a imágenes en: ${tempImgDir}`);
                await renderPdfToImages(localPath, tempImgDir, true);

                const images = (await fs.readdir(tempImgDir)).sort();
                console.log(`[2/4] Imágenes generadas: ${images.length}`);

                if (images.length === 0) throw new Error("Poppler/pdftoppm no generó ninguna imagen.");

                const firstPagePath = path.join(tempImgDir, images[0]);
                console.log(`[3/4] Intentando leer QR de: ${images[0]}`);
                const idCaratulaRaw = await readQR(firstPagePath);
                console.log(`[4/4] Resultado QR Raw: "${idCaratulaRaw}"`);

                if (!idCaratulaRaw) {
                    console.warn(`WARN: REJECTED - No se detectó QR en la primera página.`);
                    await handleLocalError(localPath, currentFileName, "SIN_QR");
                    continue;
                }

                const idLimpio = idCaratulaRaw.replace(/^"+|"+$/g, "").trim();
                const excelMetadata = await getDataFromExcel(idLimpio);

                if (!excelMetadata) {
                    console.warn(`WARN: REJECTED - ID ${idLimpio} no está en el Maestro.`);
                    await handleLocalError(localPath, currentFileName, `ID_INEXISTENTE_${idLimpio}`);
                    continue;
                }

                // ÉXITO
                const finalPath = path.join(RUTA_LOCAL_ENCOLADO, currentFileName);
                await fs.move(localPath, finalPath, { overwrite: true });

                const job = await splitQueue.add("split", {
                    filePath: finalPath,
                    fileName: currentFileName,
                    idCaratula: idLimpio,
                    excelMetadata: excelMetadata
                });

                console.log(`EXITO: Ticket ${job.id} generado.`);

                await enqueueStatusUpdate(excelMetadata.rowNumber, `Archivo recibido en cola - ${job.id}`);

            } catch (err) {
                console.error(`ERROR_DETALLE: Archivo: ${currentFileName}`);
                console.error(` Mensaje: ${err.message || 'Error sin mensaje'}`);
                await handleLocalError(localPath, currentFileName, `FALLO_SISTEMA: ${err.message || 'Desconocido'}`);
            } finally {
                if (tempImgDir) await fs.remove(tempImgDir).catch(() => { });
            }
        }
    } catch (error) {
        console.error(` CRITICAL: MONITOR_FATAL - ${error.stack}`);
    }
};

async function handleLocalError(localPath, fileName, motivo) {
    console.error(`INFO: ERROR_HANDLER - Iniciando proceso de error para ${fileName}. Motivo: ${motivo}`);
    
    try {
        if (!(await fs.pathExists(localPath))) {
            console.error(`ERROR_HANDLER_ABORTED: El archivo ${localPath} ya no existe en el disco.`);
            return;
        }

        console.log(`INFO: Leyendo archivo para subir a errores: ${localPath}`);
        const fileContent = await fs.readFile(localPath);

        console.log(`INFO: Subiendo archivo a Drive (Carpeta Errores)...`);
        await uploadFileToDrive(fileContent, fileName, SYSTEM_FOLDERS.ERRORES);
        console.log(`SUCCESS: Archivo de error subido correctamente a Drive.`);

        await fs.remove(localPath);
        console.log(`INFO: Archivo local borrado: ${localPath}`);

    } catch (e) {
        console.error(`CRITICAL_ERROR_HANDLER_FAIL: No se pudo subir/borrar el archivo de error. Detalles: ${e.message}`);
        if (e.stack) console.error(e.stack);
        
        try {
            await fs.remove(localPath);
            console.log(`INFO: Se forzó el borrado local de ${fileName} tras fallo de subida.`);
        } catch (removeErr) {
            console.error(`FATAL: Tampoco se pudo borrar el archivo local: ${removeErr.message}`);
        }
    }
}