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
            fields: "files(id, name)",
        });

        const files = res.data.files;
        if (!files || files.length === 0) return;

        for (const file of files) {
            console.log(`\n--- ESCANEANDO: ${file.name} ---`);
            let localPath = null;
            let tempImgDir = null;

            try {
                // 1. Descarga rápida para pre-escaneo
                localPath = await downloadFromDrive(file.id, `pre-${file.id}`);

                // 2. Renderizado de pág 1
                tempImgDir = path.join(PATHS.tempImg, `scan-${file.id}`);
                await fs.ensureDir(tempImgDir);
                await renderPdfToImages(localPath, tempImgDir, true);

                const images = (await fs.readdir(tempImgDir)).sort();
                const firstPagePath = path.join(tempImgDir, images[0]);

                // 3. Lectura de QR
                let idCaratulaRaw = await readQR(firstPagePath);

                if (!idCaratulaRaw) {
                    console.error(` [RECHAZADO] Sin QR: ${file.name}`);
                    await moveFile(file.id, SYSTEM_FOLDERS.ERRORES);
                    continue;
                }

                const idLimpio = idCaratulaRaw.replace(/^"+|"+$/g, "").trim();

                // 4. Verificación en Maestro
                const rowNumber = await existsIdCaratula(idLimpio);

                if (!rowNumber) {
                    console.error(` [RECHAZADO] ID ${idLimpio} no existe en Maestro.`);
                    await moveFile(file.id, SYSTEM_FOLDERS.ERRORES);
                    continue;
                }

                console.log(`✅ [VALIDADO] ID: ${idLimpio} encontrado en fila ${rowNumber}`);

                // 5. Mover a TRÁNSITO antes de encolar (evita duplicados)
                await moveFile(file.id, SYSTEM_FOLDERS.TRANSITO);

                // 6. ENCOLAR Y OBTENER EL JOB ID
                const job = await splitQueue.add("split", {
                    fileId: file.id,
                    fileName: file.name,
                    idCaratula: idLimpio,
                    tenant: "Automatico"
                });
                
                await updateSheetRow(
                    rowNumber, 
                    "maestro", 
                    "Estado_Carga", 
                    `Archivo recibido correctamente. Su Ticket de seguimiento: ${job.id}`
                );

                await updateSheetRow(
                    2, 
                    "monitoreo", 
                    "Ultimo_Ticket", 
                    job.id
                );

            } catch (err) {
                console.error(`🚨 [ERROR] Falló análisis de ${file.name}:`, err.message);
                try {
                    await moveFile(file.id, SYSTEM_FOLDERS.ERRORES);
                } catch (e) { /* Error silencioso */ }
            } finally {
                if (localPath) await fs.remove(localPath).catch(() => { });
                if (tempImgDir) await fs.remove(tempImgDir).catch(() => { });
            }
        }
    } catch (error) {
        console.error("💀 [MONITOR FATAL ERROR]:", error);
    }
};