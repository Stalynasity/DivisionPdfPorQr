import { splitQueue } from "../jobs/queue.js";
import { SYSTEM_FOLDERS, PATHS } from "../config/tenants.js";
import { moveFile, getDriveClient, downloadFromDrive } from "./drive.service.js";
import { renderPdfToImages } from "./render.service.js";
import { readQR } from "./qr.service.js";
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
            console.log(`\n--- ANALIZANDO: ${file.name} ---`);
            let localPath = null;
            let tempImgDir = null;

            try {
                // 1. Descarga para pre-escaneo
                localPath = await downloadFromDrive(file.id, `pre-${file.id}`);

                // 2. Renderizado solo de la pág 1 (Ahorra CPU y tiempo)
                tempImgDir = path.join(PATHS.tempImg, `scan-${file.id}`);
                await fs.ensureDir(tempImgDir);
                await renderPdfToImages(localPath, tempImgDir, true);

                const images = (await fs.readdir(tempImgDir)).sort();
                const firstPagePath = path.join(tempImgDir, images[0]);

                // 3. Intento de lectura de QR
                let idCaratula = await readQR(firstPagePath);

                // --- FILTRO CRÍTICO ---
                if (!idCaratula) {
                    console.error(`[RECHAZADO] ${file.name} no tiene QR. Moviendo a ERRORES.`);
                    await moveFile(file.id, SYSTEM_FOLDERS.ERRORES);
                    continue; // <--- AQUÍ SE CANCELA TODO Y NO ENTRA A LA COLA
                }

                // 4. Si pasó los filtros, movemos a TRÁNSITO y encolamos
                console.log(`[APROBADO] QR: ${idCaratula}. Preparando para procesamiento...`);
                await moveFile(file.id, SYSTEM_FOLDERS.TRANSITO);

                await splitQueue.add("split", {
                    fileId: file.id,
                    fileName: file.name,
                    idCaratula: idCaratula.replace(/^"+|"+$/g, "").trim(),
                    tenant: "Automatico"
                });

                console.log(`[OK] Encolado con éxito.`);

            } catch (err) {
                console.error(`[ERROR] Falló análisis de ${file.name}:`, err.message);
                try {
                    await moveFile(file.id, SYSTEM_FOLDERS.ERRORES);
                } catch (e) { /* Evitar bucle de error */ }
            } finally {
                if (localPath) await fs.remove(localPath).catch(() => { });
                if (tempImgDir) await fs.remove(tempImgDir).catch(() => { });
            }
        }
    } catch (error) {
        console.error("[MONITOR FATAL ERROR]:", error);
    }
};