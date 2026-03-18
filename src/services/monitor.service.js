import { splitQueue } from "../jobs/queue.js";
import { SYSTEM_FOLDERS, PATHS } from "../config/tenants.js";
import { uploadToDrive } from "./drive.service.js";
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
        await fs.ensureDir(RUTA_LOCAL_ENTRADA);
        await fs.ensureDir(RUTA_LOCAL_ENCOLADO);

        const files = await fs.readdir(RUTA_LOCAL_ENTRADA);
        const pdfFiles = files.filter(f => f.toLowerCase().endsWith('.pdf'));

        if (pdfFiles.length === 0) return;

        for (const fileName of pdfFiles) {
            const localPath = path.join(RUTA_LOCAL_ENTRADA, fileName);
            let tempImgDir = null;

            if (fileName.length > 100) {
                const ext = path.extname(fileName);
                const base = path.basename(fileName, ext).substring(0, 50); // Tomamos solo los primeros 50
                const newFileName = `${base}_${Date.now()}${ext}`;
                const newPath = path.join(RUTA_LOCAL_ENTRADA, newFileName);

                try {
                    await fs.rename(localPath, newPath);
                    fileName = newFileName;
                    localPath = newPath;
                } catch (renameErr) {
                    console.error(`No se pudo renombrar, se intentará procesar original: ${renameErr.message}`);
                }
            }

            console.log(`\n---PROCESANDO: ${fileName} ---`);

            try {
                // LOG 1: Verificar existencia física
                if (!await fs.pathExists(localPath)) {
                    throw new Error(`El archivo desapareció antes de procesar: ${localPath}`);
                }

                tempImgDir = path.join(PATHS.tempImg, `scan-${Date.now()}`);
                await fs.ensureDir(tempImgDir);

                // LOG 2: Renderizado
                console.log(`[1/4] Renderizando PDF a imágenes en: ${tempImgDir}`);
                await renderPdfToImages(localPath, tempImgDir, true);

                const images = (await fs.readdir(tempImgDir)).sort();
                console.log(`[2/4] Imágenes generadas: ${images.length}`);

                if (images.length === 0) throw new Error("Poppler/pdftoppm no generó ninguna imagen.");

                // LOG 3: Lectura QR
                const firstPagePath = path.join(tempImgDir, images[0]);
                console.log(`[3/4] Intentando leer QR de: ${images[0]}`);
                const idCaratulaRaw = await readQR(firstPagePath);
                console.log(`[4/4] Resultado QR Raw: "${idCaratulaRaw}"`);

                if (!idCaratulaRaw) {
                    console.warn(`WARN: REJECTED - No se detectó QR en la primera página.`);
                    await handleLocalError(localPath, fileName, "SIN_QR");
                    continue;
                }

                const idLimpio = idCaratulaRaw.replace(/^"+|"+$/g, "").trim();

                const rowNumber = await existsIdCaratula(idLimpio);

                if (!rowNumber) {
                    console.warn(`WARN: REJECTED - ID ${idLimpio} no está en el Maestro.`);
                    await handleLocalError(localPath, fileName, `ID_INEXISTENTE_${idLimpio}`);
                    continue;
                }

                // ÉXITO
                const finalPath = path.join(RUTA_LOCAL_ENCOLADO, fileName);
                await fs.move(localPath, finalPath, { overwrite: true });

                const job = await splitQueue.add("split", {
                    filePath: finalPath,
                    fileName: fileName,
                    idCaratula: idLimpio
                });

                console.log(`EXITO: Ticket ${job.id} generado.`);

                await updateSheetRow(rowNumber, "maestro", "Estado_Carga", `Archivo recibido en cola - Tu Ticket: ${job.id}`);

            } catch (err) {
                // LOG DE ERROR MEJORADO
                console.error(`ERROR_DETALLE: Archivo: ${fileName}`);
                console.error(` Mensaje: ${err.message || 'Error sin mensaje (null/undefined)'}`);
                console.error(` Stack: ${err.stack}`); // Esto te dirá la línea exacta del fallo
                await handleLocalError(localPath, fileName, `FALLO_SISTEMA: ${err.message || 'Desconocido'}`);
            } finally {
                if (tempImgDir) await fs.remove(tempImgDir).catch(() => { });
            }
        }
    } catch (error) {
        console.error(` CRITICAL: MONITOR_FATAL - ${error.stack}`);
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

        await uploadToDrive(fileName, fileContent, SYSTEM_FOLDERS.ERRORES);

        // Borramos del local para no procesar de nuevo
        await fs.remove(localPath);
    } catch (e) {
        console.error(`CRITICAL: No se pudo subir el archivo de error a Drive: ${e.message}`);
        await uploadToDrive(fileName, fileContent, SYSTEM_FOLDERS.ERRORES);
        await fs.remove(localPath);
    }
}