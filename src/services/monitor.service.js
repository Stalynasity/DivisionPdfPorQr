import { splitQueue } from "../jobs/queue.js";
import { SYSTEM_FOLDERS, PATHS } from "../config/tenants.js";
import { uploadToDrive } from "./drive.service.js"; // Añadimos uploadToDrive
import { renderPdfToImages } from "./render.service.js";
import { readQR } from "./qr.service.js";
import { updateSheetRow, existsIdCaratula } from "../services/excel.service.js";
import fs from "fs-extra";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const RUTA_LOCAL_ENTRADA = process.env.PATH_ENTRADA_LOCAL;
const RUTA_LOCAL_ENCOLADO = process.env.PATH_ENCOLADO_LOCAL;

export const watchInputFolder = async () => {
    try {
        // Asegurar que existan las rutas locales
        await fs.ensureDir(RUTA_LOCAL_ENTRADA);
        await fs.ensureDir(RUTA_LOCAL_ENCOLADO);

        // 1. Leer archivos de la carpeta local
        const files = await fs.readdir(RUTA_LOCAL_ENTRADA);
        const pdfFiles = files.filter(f => f.toLowerCase().endsWith('.pdf'));

        if (pdfFiles.length === 0) return;

        for (const fileName of pdfFiles) {
            const localPath = path.join(RUTA_LOCAL_ENTRADA, fileName);
            let tempImgDir = null;

            try {

                // 2. Preparar previsualización para QR
                tempImgDir = path.join(PATHS.tempImg, `scan-${Date.now()}`);
                await fs.ensureDir(tempImgDir);
                
                await renderPdfToImages(localPath, tempImgDir, true);
                const images = (await fs.readdir(tempImgDir)).sort();
                
                if (images.length === 0) throw new Error("No se pudo renderizar el PDF");

                const firstPagePath = path.join(tempImgDir, images[0]);
                const idCaratulaRaw = await readQR(firstPagePath);

                // --- VALIDACIONES LÓGICAS ---

                // Caso A: No hay QR
                if (!idCaratulaRaw) {
                    console.warn(`WARN: REJECTED - No QR en: ${fileName}`);
                    await handleLocalError(localPath, fileName, "SIN_QR");
                    continue;
                }

                const idLimpio = idCaratulaRaw.replace(/^"+|"+$/g, "").trim();
                const rowNumber = await existsIdCaratula(idLimpio);

                // Caso B: QR no existe en Maestro
                if (!rowNumber) {
                    console.warn(`WARN: REJECTED - ID ${idLimpio} no existe en Excel | Archivo: ${fileName}`);
                    await handleLocalError(localPath, fileName, `ID_INEXISTENTE_${idLimpio}`);
                    continue;
                }

                // --- ÉXITO: MOVER A ENCOLADO Y DISPARAR QUEUE ---

                const finalPath = path.join(RUTA_LOCAL_ENCOLADO, fileName);
                await fs.move(localPath, finalPath, { overwrite: true });

                const job = await splitQueue.add("split", {
                    filePath: finalPath, // Ahora pasamos ruta local
                    fileName: fileName,
                    idCaratula: idLimpio
                });

                console.log(`INFO: COMPLETED - File: ${fileName} | ID: ${idLimpio} | Ticket: ${job.id}`);

                await updateSheetRow(rowNumber, "maestro", "Estado_Carga", `Encolado Local. Ticket: ${job.id}`);
                await updateSheetRow(2, "monitoreo", "Ultimo_Ticket", job.id);

            } catch (err) {
                console.error(`ERROR: FAILED_FILE - ${fileName} | Reason: ${err.message}`);
                await handleLocalError(localPath, fileName, "ERROR_SISTEMA");
            } finally {
                if (tempImgDir) await fs.remove(tempImgDir).catch(() => { });
            }
        }
    } catch (error) {
        console.error(`CRITICAL: MONITOR_FATAL - ${error.message}`);
    }
};

/**
 * Función para manejar errores: Sube el archivo al Drive de errores y lo borra del local
 */
async function handleLocalError(localPath, fileName, motivo) {
    try {
        console.error(`INFO: ERROR_HANDLER - Subiendo ${fileName} a carpeta de Errores en Drive por: ${motivo}`);
        
        // Leemos el archivo local para subirlo
        const fileContent = await fs.readFile(localPath);
        
        // Usamos una función de subida (asegúrate de tenerla en drive.service.js)
        await uploadToDrive(fileName, fileContent, SYSTEM_FOLDERS.ERRORES);
        
        // Borramos del local para no procesar de nuevo
        await fs.remove(localPath);
    } catch (e) {
        console.error(`CRITICAL: No se pudo subir el archivo de error a Drive: ${e.message}`);
    }
}