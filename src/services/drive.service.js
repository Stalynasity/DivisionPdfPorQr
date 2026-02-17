import { google } from "googleapis";
import fs from "fs";
import { PATHS } from "../config/tenants.js";
import { Readable } from "stream";
import fsExtra from "fs-extra";
import { getOAuthClient } from "./auth.oauth.js";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: "./.env" });

let driveInstance;

// Exportar cliente drive para otros servicios
export const getDriveClient = async () => {
    if (!driveInstance) {
        console.log("[DRIVE] Inicializando nueva instancia de cliente...");
        const auth = await getOAuthClient();
        driveInstance = google.drive({ version: "v3", auth });
        console.log("[DRIVE] Cliente listo.");
    }
    return driveInstance;
};

// ========================= DOWNLOAD =========================
export const downloadFromDrive = async (fileId, jobId) => {
    console.log(`[DRIVE] Iniciando descarga de archivo ID: ${fileId} para Job: ${jobId}`);
    const drive = await getDriveClient();
    const dirPath = PATHS.tempPdf;

    await fsExtra.ensureDir(dirPath);

    const destPath = path.join(dirPath, `job-${jobId}.pdf`);
    const dest = fs.createWriteStream(destPath);

    try {
        const res = await drive.files.get(
            { fileId, alt: "media" },
            { responseType: "stream" }
        );

        console.log(`[DRIVE] Stream de descarga recibido. Transfiriendo a disco...`);

        await new Promise((resolve, reject) => {
            res.data.pipe(dest);
            dest.on("finish", () => {
                console.log(`[DRIVE] Descarga completada exitosamente: ${destPath}`);
                resolve();
            });
            dest.on("error", (err) => {
                console.error(`[DRIVE] Error en el stream de escritura: ${err.message}`);
                reject(err);
            });
            res.data.on("error", (err) => {
                console.error(`[DRIVE] Error en el stream de lectura (Google): ${err.message}`);
                reject(err);
            });
        });

        return destPath;
    } catch (error) {
        console.error(`[DRIVE] Error fatal en descarga: ${error.message}`);
        throw error;
    }
};

// ========================= UPLOAD =========================
export const saveToDrive = async (fileBuffer, name, folderId) => {
    console.log(`[DRIVE] Subiendo archivo: ${name} a la carpeta: ${folderId}`);
    const drive = await getDriveClient();
    const bufferStream = new Readable();
    bufferStream.push(fileBuffer);
    bufferStream.push(null);

    try {
        const res = await drive.files.create({
            requestBody: { name, parents: [folderId] },
            media: { mimeType: "application/pdf", body: bufferStream },
            supportsAllDrives: true
        });

        console.log(`[DRIVE] Subida terminada. Nuevo ID: ${res.data.id}`);
        return res.data.id;
    } catch (error) {
        console.error(`[DRIVE] Error en subida: ${error.message}`);
        throw error;
    }
};

// ========================= MOVE =========================
export const moveFile = async (fileId, targetFolderId) => {
    console.log(`[DRIVE] Moviendo archivo ${fileId} hacia carpeta ${targetFolderId}...`);
    const drive = await getDriveClient();

    try {
        // Obtener la ubicación actual
        const file = await drive.files.get({ fileId, fields: "parents" });

        if (!file.data.parents) {
            throw new Error("El archivo no tiene padres conocidos o no se pudo acceder a ellos.");
        }

        const previousParents = file.data.parents.join(",");

        // Mover archivo
        await drive.files.update({
            fileId: fileId,
            addParents: targetFolderId,
            removeParents: previousParents,
            fields: "id, parents",
        });

        console.log(`[DRIVE] Archivo movido con éxito.`);
    } catch (error) {
        console.error(`[DRIVE] Error al mover archivo: ${error.message}`);
        throw error;
    }
};