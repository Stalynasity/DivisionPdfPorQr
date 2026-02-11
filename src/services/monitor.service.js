import { google } from "googleapis";
import { getOAuthClient } from "./auth.oauth.js";
import { splitQueue } from "../queue/queue.js";
import { SYSTEM_FOLDERS } from "../config/tenants.js";
import { moveFile } from "./drive.service.js"; // Asegúrate de importar moveFile

export const watchInputFolder = async () => {
    const auth = await getOAuthClient();
    const drive = google.drive({ version: "v3", auth });

    try {
        const res = await drive.files.list({
            q: `'${SYSTEM_FOLDERS.ENTRADA}' in parents and mimeType = 'application/pdf' and trashed = false`,
            fields: "files(id, name)",
        });

        const files = res.data.files;
        if (files.length === 0) return;

        for (const file of files) {
            console.log(`[MONITOR] Detectado: ${file.name}. Moviendo a TRANSITO...`);
            
            // 1. Mover a tránsito primero para "bloquearlo"
            await moveFile(file.id, SYSTEM_FOLDERS.TRANSITO);

            // 2. Encolar una vez que ya no está en la carpeta de entrada
            await splitQueue.add("split", {
                fileId: file.id,
                fileName: file.name,
                tenant: "produccion" 
            });
            
            console.log(`[MONITOR] Archivo ${file.name} encolado correctamente.`);
        }
    } catch (error) {
        console.error("Error en monitor:", error);
    }
};