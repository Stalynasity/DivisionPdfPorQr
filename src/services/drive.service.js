import { google } from "googleapis";
import { Readable } from "stream";
import { getOAuthClient } from "./auth.oauth.js";
import Redis from "ioredis";
import { connection } from "../config/redis.js";

const redisClient = new Redis(connection);

let driveInstance;

export const getDriveClient = async () => {
    if (!driveInstance) {
        const auth = await getOAuthClient();
        driveInstance = google.drive({ version: "v3", auth });
    }
    return driveInstance;
};

// ============================================================================
// 1. HELPERS INTERNOS (DRY)
// ============================================================================

/**
 * Convierte un Buffer en un Readable Stream necesario para Google Drive
 */
const bufferToStream = (buffer) => {
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);
    return stream;
};

// ============================================================================
// 2. OPERACIONES DE ARCHIVOS (Unificadas y Flexibles)
// ============================================================================

/**
 * Acepta un mimeType dinámico, pero por defecto es PDF (Open/Closed Principle).
 */
export const uploadFileToDrive = async (fileBuffer, name, folderId, mimeType = "application/pdf") => {
    try {
        const drive = await getDriveClient();
        
        const res = await drive.files.create({
            requestBody: { name, parents: [folderId] },
            media: { mimeType, body: bufferToStream(fileBuffer) },
            supportsAllDrives: true
        });

        return res.data.id;
    } catch (error) {
        console.error(`ERROR: DRIVE_UPLOAD_FAILED - File: ${name} | Msg: ${error.message}`);
        throw error;
    }
};

/**
 * Mueve un archivo a otra carpeta
 */
export const moveFile = async (fileId, targetFolderId) => {
    try {
        const drive = await getDriveClient();
        const file = await drive.files.get({ fileId, fields: "parents" });
        
        if (!file.data.parents) throw new Error("NO_PARENTS_FOUND");

        const previousParents = file.data.parents.join(",");

        await drive.files.update({
            fileId,
            addParents: targetFolderId,
            removeParents: previousParents,
            fields: "id, parents",
            supportsAllDrives: true // Buena práctica agregarlo aquí también para unidades compartidas
        });

    } catch (error) {
        console.error(`ERROR: DRIVE_MOVE_FAILED - File: ${fileId} | Msg: ${error.message}`);
        throw error;
    }
};

// ============================================================================
// 3. OPERACIONES DE CARPETAS (Optimizadas con Caché)
// ============================================================================
/**
 * Obtiene o crea una jerarquía de carpetas usando Redis para ahorrar peticiones a la API
 */
export const getOrCreateFolderPath = async (rootFolderId, pathArray) => {
    // Limpiamos el array por si vienen nulos
    const cleanPathArray = pathArray.filter(Boolean);
    if (cleanPathArray.length === 0) return rootFolderId;

    // 1. Crear una clave única de caché para esta ruta completa
    const fullPathString = cleanPathArray.join("/");
    const cacheKey = `drive_folder_cache:${rootFolderId}:${fullPathString}`;

    // 2. BUSCAR EN REDIS (Cero consumo de API de Google)
    const cachedFolderId = await redisClient.get(cacheKey);
    if (cachedFolderId) {
        console.log(`[CACHE HIT] Carpeta encontrada en Redis: ${fullPathString}`);
        return cachedFolderId;
    }

    // 3. Si no está en caché, hacemos el proceso normal consultando a Drive
    console.log(`[CACHE MISS] Consultando Drive para la ruta: ${fullPathString}`);
    const drive = await getDriveClient();
    let currentParentId = rootFolderId;

    for (const folderName of cleanPathArray) {
        const safeFolderName = folderName.replace(/'/g, "\\'"); // Sanitización
        const query = `name = '${safeFolderName}' and '${currentParentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
        
        const res = await drive.files.list({ 
            q: query, 
            fields: 'files(id, name)', 
            supportsAllDrives: true, 
            includeItemsFromAllDrives: true 
        });

        if (res.data.files.length > 0) {
            currentParentId = res.data.files[0].id;
        } else {
            // Crear si no existe
            const newFolder = await drive.files.create({
                resource: {
                    name: folderName, 
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: [currentParentId]
                },
                fields: 'id',
                supportsAllDrives: true
            });
            currentParentId = newFolder.data.id;
        }
    }

    // 4. GUARDAR EN REDIS (Expira en 24 horas para no acumular basura si borras carpetas manualmente)
    // 86400 segundos = 24 horas
    await redisClient.set(cacheKey, currentParentId, "EX", 86400);

    return currentParentId;
};

/**
 * Crea una copia de seguridad de un archivo existente en una carpeta específica
 */
export const backupFile = async (fileId, backupFolderName = "BACKUPS_SISTEMA") => {
    try {
        const drive = await getDriveClient();
        
        // 1. Obtener el nombre del archivo original para ponerle fecha al backup
        const originalFile = await drive.files.get({ fileId, fields: "name" });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupName = `BACKUP_${timestamp}_${originalFile.data.name}`;

        // 2. Buscar o crear la carpeta de Backups
        const rootId = process.env.ID_CARPETA_ORIGEN_BACKUP; 
        const backupFolderId = await getOrCreateFolderPath(rootId, [backupFolderName]);

        console.log(`[DRIVE] Generando backup: ${backupName}...`);

        // 3. Ejecutar la copia
        const res = await drive.files.copy({
            fileId: fileId,
            requestBody: {
                name: backupName,
                parents: [backupFolderId]
            },
            supportsAllDrives: true
        });

        console.log(`[SUCCESS] Backup creado con ID: ${res.data.id}`);
        return res.data.id;
    } catch (error) {
        console.error(`ERROR: DRIVE_BACKUP_FAILED - ${error.message}`);
        throw new Error("No se pudo realizar el backup de seguridad. Abortando mantenimiento.");
    }
};