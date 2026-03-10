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

export const getDriveClient = async () => {
    if (!driveInstance) {
        const auth = await getOAuthClient();
        driveInstance = google.drive({ version: "v3", auth });
    }
    return driveInstance;
};

// ========================= DOWNLOAD =========================
export const downloadFromDrive = async (fileId, jobId) => {
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

        await new Promise((resolve, reject) => {
            res.data.pipe(dest);
            dest.on("finish", resolve);
            dest.on("error", (err) => reject(new Error(`WRITE_STREAM_ERROR: ${err.message}`)));
            res.data.on("error", (err) => reject(new Error(`READ_STREAM_ERROR: ${err.message}`)));
        });

        return destPath;
    } catch (error) {
        console.error(`ERROR: DRIVE_DOWNLOAD_FAILED - File: ${fileId} | Reason: ${error.message}`);
        throw error;
    }
};

// ========================= UPLOAD =========================
export const saveToDrive = async (fileBuffer, name, folderId) => {
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

        return res.data.id;
    } catch (error) {
        console.error(`ERROR: DRIVE_UPLOAD_FAILED - Name: ${name} | Reason: ${error.message}`);
        throw error;
    }
};

// ========================= MOVE =========================
export const moveFile = async (fileId, targetFolderId) => {
    const drive = await getDriveClient();

    try {
        const file = await drive.files.get({ fileId, fields: "parents" });
        if (!file.data.parents) throw new Error("NO_PARENTS_FOUND");

        const previousParents = file.data.parents.join(",");

        await drive.files.update({
            fileId: fileId,
            addParents: targetFolderId,
            removeParents: previousParents,
            fields: "id, parents",
        });

    } catch (error) {
        console.error(`ERROR: DRIVE_MOVE_FAILED - File: ${fileId} | Reason: ${error.message}`);
        throw error;
    }
};

// ========================= GET OR CREATE FOLDER PATH =========================
export const getOrCreateFolderPath = async (rootFolderId, pathArray) => {
    const drive = await getDriveClient();
    let currentParentId = rootFolderId;

    for (const folderName of pathArray) {
        if (!folderName) continue;
        
        const query = `name = '${folderName}' and '${currentParentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
        const res = await drive.files.list({ 
            q: query, 
            fields: 'files(id, name)', 
            supportsAllDrives: true, 
            includeItemsFromAllDrives: true 
        });

        if (res.data.files.length > 0) {
            currentParentId = res.data.files[0].id;
        } else {
            const folderMetadata = {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [currentParentId]
            };
            const newFolder = await drive.files.create({
                resource: folderMetadata,
                fields: 'id',
                supportsAllDrives: true
            });
            currentParentId = newFolder.data.id;
            console.log(`INFO: DRIVE_FOLDER_CREATED - Name: ${folderName} | Parent: ${currentParentId}`);
        }
    }
    return currentParentId;
};