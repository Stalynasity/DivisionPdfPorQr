import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import fsExtra from "fs-extra";
import { getOAuthClient } from "./auth.oauth.js";
import dotenv from "dotenv";

dotenv.config({ path: "./.env" });

// Inicializar Drive
const auth = await getOAuthClient();
const drive = google.drive({ version: "v3", auth });

// Exportar cliente drive para otros servicios
export { drive };

// ========================= DOWNLOAD =========================
export const downloadFromDrive = async (fileId) => {
    const dirPath = path.join("tmp", "pdf");
    await fsExtra.ensureDir(dirPath);
    const destPath = path.join(dirPath, `temp_${Date.now()}.pdf`);
    const dest = fs.createWriteStream(destPath);

    const res = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "stream" }
    );

    await new Promise((resolve, reject) => {
        res.data.pipe(dest);
        dest.on("finish", resolve);
        dest.on("error", reject);
    });

    return destPath;
};

// ========================= UPLOAD =========================
export const saveToDrive = async (fileBuffer, name, folderId) => {
    const bufferStream = new Readable();
    bufferStream.push(fileBuffer);
    bufferStream.push(null);

    const res = await drive.files.create({
        requestBody: { name, parents: [folderId] },
        media: { mimeType: "application/pdf", body: bufferStream },
        supportsAllDrives: true
    });

    return res.data.id;
};

export const moveFile = async (fileId, targetFolderId) => {
    const auth = await getOAuthClient();
    const drive = google.drive({ version: "v3", auth });

    // Obtener la ubicación actual para quitarla
    const file = await drive.files.get({ fileId, fields: "parents" });
    const previousParents = file.data.parents.join(",");

    // Mover archivo
    await drive.files.update({
        fileId: fileId,
        addParents: targetFolderId,
        removeParents: previousParents,
        fields: "id, parents",
    });
};