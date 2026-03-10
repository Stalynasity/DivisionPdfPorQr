import { splitQueue } from "../jobs/queue.js";
import { SYSTEM_FOLDERS, PATHS } from "../config/tenants.js";
import { moveFile, getDriveClient, downloadFromDrive } from "./drive.service.js";
import { renderPdfToImages } from "./render.service.js";
import { readQR } from "./qr.service.js";
import { updateSheetRow, existsIdCaratula } from "../services/excel.service.js";
import fs from "fs-extra";
import path from "path";

export const watchInputFolder = async () => {
    const drive = await getDriveClient();

    try {
        const res = await drive.files.list({
            q: `'${SYSTEM_FOLDERS.ENTRADA}' in parents and mimeType = 'application/pdf' and trashed = false`,
            pageSize: 20,
            fields: "files(id, name)",
            //supportsAllDrives: true,
            //includeItemsFromAllDrives: true
        });

        const files = res.data.files;
        if (!files || files.length === 0) return;

        for (const file of files) {
            let localPath = null;
            let tempImgDir = null;

            try {
                // Log único de inicio de proceso
                console.log(`INFO: PROCESSING_FILE - Name: ${file.name}`);

                localPath = await downloadFromDrive(file.id, `pre-${file.id}`);
                tempImgDir = path.join(PATHS.tempImg, `scan-${file.id}`);
                await fs.ensureDir(tempImgDir);
                await renderPdfToImages(localPath, tempImgDir, true);

                const images = (await fs.readdir(tempImgDir)).sort();
                const firstPagePath = path.join(tempImgDir, images[0]);

                let idCaratulaRaw = await readQR(firstPagePath);

                // Casos de rechazo lógico (WARN)
                if (!idCaratulaRaw) {
                    console.warn(`WARN: REJECTED - No se detectó QR en: ${file.name}`);
                    await moveFile(file.id, SYSTEM_FOLDERS.ERRORES);
                    continue;
                }

                const idLimpio = idCaratulaRaw.replace(/^"+|"+$/g, "").trim();
                const rowNumber = await existsIdCaratula(idLimpio);

                if (!rowNumber) {
                    console.warn(`WARN: REJECTED - ID ${idLimpio} no existe en Maestro | Archivo: ${file.name}`);
                    await moveFile(file.id, SYSTEM_FOLDERS.ERRORES);
                    continue;
                }

                await moveFile(file.id, SYSTEM_FOLDERS.TRANSITO);

                const job = await splitQueue.add("split", {
                    fileId: file.id,
                    fileName: file.name,
                    idCaratula: idLimpio
                });

                // Log de éxito final: Resume toda la operación
                console.log(`INFO: COMPLETED - File: ${file.name} | ID: ${idLimpio} | Ticket: ${job.id}`);

                await updateSheetRow(rowNumber, "maestro", "Estado_Carga", `Archivo recibido. Ticket: ${job.id}`);
                await updateSheetRow(2, "monitoreo", "Ultimo_Ticket", job.id);

            } catch (err) {
                // Solo reportamos el error si realmente algo falló en la ejecución
                console.error(`ERROR: FAILED_FILE - ${file.name} | Reason: ${err.message}`);
                try {
                    await moveFile(file.id, SYSTEM_FOLDERS.ERRORES);
                } catch (e) { }
            } finally {
                if (localPath) await fs.remove(localPath).catch(() => { });
                if (tempImgDir) await fs.remove(tempImgDir).catch(() => { });
            }
        }
    } catch (error) {
        console.error(`CRITICAL: MONITOR_FATAL - ${error.message}`);
    }
};