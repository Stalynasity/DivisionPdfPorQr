import { google } from "googleapis";
import { Readable } from "stream";
import { getOAuthClient } from "./auth.service.js";
import Redis from "ioredis";
import { connection } from "../config/redis.js";

const redis = new Redis(connection);

let clienteDrive;
const obtenerClienteDrive = async () => {
    if (!clienteDrive) {
        const auth = await getOAuthClient();
        clienteDrive = google.drive({ version: "v3", auth });
    }
    return clienteDrive;
};

const OPCIONES_DRIVE = { supportsAllDrives: true, includeItemsFromAllDrives: true };
const MIME_CARPETA   = "application/vnd.google-apps.folder";
const TTL_CACHE      = 86_400; // 24 h en segundos

// ─── Archivos ─────────────────────────────────────────────────────────────────

/**
 * Sube un Buffer a Drive con progreso cada 20%.
 */
export const subirArchivoDrive = async (buffer, nombre, carpetaId, mimeType = "application/pdf") => {
    const drive = await obtenerClienteDrive();

    const res = await drive.files.create(
        {
            requestBody: { name: nombre, parents: [carpetaId] },
            media: { mimeType, body: Readable.from(buffer) },
            fields: "id",
            supportsAllDrives: true,
        },
        {
            onUploadProgress: ({ bytesRead }) => {
                const pct = Math.round((bytesRead / buffer.length) * 100);
                if (pct % 20 === 0) console.log(`[DRIVE] Subiendo ${nombre}: ${pct}%`);
            },
        }
    );

    return res.data.id;
};

/**
 * Mueve un archivo a otra carpeta eliminándolo de la anterior.
 */
export const moverArchivo = async (archivoId, carpetaDestinoId) => {
    const drive   = await obtenerClienteDrive();
    const archivo = await drive.files.get({ fileId: archivoId, fields: "parents" });

    if (!archivo.data.parents?.length) throw new Error(`SIN_CARPETA_PADRE: ${archivoId}`);

    await drive.files.update({
        fileId:        archivoId,
        addParents:    carpetaDestinoId,
        removeParents: archivo.data.parents.join(","),
        fields:        "id, parents",
        supportsAllDrives: true,
    });
};

// ─── Carpetas ─────────────────────────────────────────────────────────────────

/**
 * Resuelve (o crea) una jerarquía de carpetas en Drive usando Redis como caché.
 * Evita múltiples llamadas a la API cuando la misma ruta se procesa repetidamente.
 */
export const obtenerOCrearRutaCarpeta = async (carpetaRaizId, segmentos) => {
    const segmentosValidos = segmentos.filter(Boolean);
    if (!segmentosValidos.length) return carpetaRaizId;

    const claveCache  = `drive_folder_cache:${carpetaRaizId}:${segmentosValidos.join("/")}`;
    const enCache     = await redis.get(claveCache);
    if (enCache) {
        console.log(`[DRIVE] Cache hit: ${segmentosValidos.join("/")}`);
        return enCache;
    }

    const drive          = await obtenerClienteDrive();
    let carpetaPadreId   = carpetaRaizId;

    for (const nombreCarpeta of segmentosValidos) {
        const nombreSeguro = nombreCarpeta.replace(/'/g, "\\'");
        const query        = `name='${nombreSeguro}' and '${carpetaPadreId}' in parents and mimeType='${MIME_CARPETA}' and trashed=false`;

        const res = await drive.files.list({ q: query, fields: "files(id)", ...OPCIONES_DRIVE });

        if (res.data.files.length) {
            carpetaPadreId = res.data.files[0].id;
        } else {
            const nueva = await drive.files.create({
                requestBody: { name: nombreCarpeta, mimeType: MIME_CARPETA, parents: [carpetaPadreId] },
                fields: "id",
                supportsAllDrives: true,
            });
            carpetaPadreId = nueva.data.id;
        }
    }

    await redis.set(claveCache, carpetaPadreId, "EX", TTL_CACHE);
    return carpetaPadreId;
};

/**
 * Crea una copia de seguridad de un archivo Drive en una carpeta dedicada.
 */
export const respaldarArchivo = async (archivoId, nombreCarpetaBackup = "BACKUPS_SISTEMA") => {
    const drive    = await obtenerClienteDrive();
    const original = await drive.files.get({ fileId: archivoId, fields: "name" });
    const ts       = new Date().toISOString().replace(/[:.]/g, "-");
    const nombre   = `BACKUP_${ts}_${original.data.name}`;

    const carpetaId = await obtenerOCrearRutaCarpeta(
        process.env.ID_CARPETA_ORIGEN_BACKUP,
        [nombreCarpetaBackup]
    );

    const res = await drive.files.copy({
        fileId: archivoId,
        requestBody: { name: nombre, parents: [carpetaId] },
        supportsAllDrives: true,
    });

    console.log(`[DRIVE] Backup creado: ${nombre} (${res.data.id})`);
    return res.data.id;
};

/**
 * Elimina archivos más antiguos que `diasLimite` y carpetas vacías de forma recursiva.
 * @returns {{ archivosBorrados: number, carpetasBorradas: number }}
 */
export const limpiarDriveEnProfundidad = async (carpetasRaiz, diasLimite = 21) => {
    const drive  = await obtenerClienteDrive();
    const corte  = new Date();
    corte.setDate(corte.getDate() - diasLimite);

    const stats = { archivosBorrados: 0, carpetasBorradas: 0 };
    console.log(`[DRIVE] Limpieza — corte: ${corte.toISOString()}`);

    for (const carpetaId of carpetasRaiz) {
        await limpiarCarpetaRecursiva(drive, carpetaId, corte, stats).catch((e) =>
            console.error(`[DRIVE] Error en carpeta ${carpetaId}: ${e.message}`)
        );
    }

    return stats;
};

// ─── Recursivo privado ────────────────────────────────────────────────────────

const enviarAPapelera = (drive, archivoId) =>
    drive.files.update({ fileId: archivoId, requestBody: { trashed: true }, supportsAllDrives: true });

async function limpiarCarpetaRecursiva(drive, carpetaId, corte, stats) {
    let tokenPagina = null;

    do {
        const res = await drive.files.list({
            q:         `'${carpetaId}' in parents and trashed=false`,
            fields:    "nextPageToken, files(id, name, mimeType, modifiedTime, createdTime)",
            pageSize:  1000,
            pageToken: tokenPagina,
            ...OPCIONES_DRIVE,
        });

        tokenPagina = res.data.nextPageToken ?? null;

        for (const item of res.data.files ?? []) {
            if (item.mimeType === MIME_CARPETA) {
                // Primero limpiar contenido, luego evaluar si quedó vacía
                await limpiarCarpetaRecursiva(drive, item.id, corte, stats);

                const verificacion = await drive.files.list({
                    q: `'${item.id}' in parents and trashed=false`,
                    pageSize: 1,
                    fields: "files(id)",
                    ...OPCIONES_DRIVE,
                });

                if (!verificacion.data.files?.length) {
                    console.log(`[DRIVE] Carpeta vacía eliminada: ${item.name}`);
                    await enviarAPapelera(drive, item.id);
                    stats.carpetasBorradas++;
                }
            } else {
                const fecha = new Date(item.modifiedTime ?? item.createdTime);
                if (fecha < corte) {
                    console.log(`[DRIVE] Archivo eliminado: ${item.name} (${fecha.toLocaleDateString()})`);
                    await enviarAPapelera(drive, item.id);
                    stats.archivosBorrados++;
                }
            }
        }
    } while (tokenPagina);
}