import fs from "fs-extra";
import path from "path";
import { splitQueue } from "../jobs/queue.js";
import { SYSTEM_FOLDERS, PATHS } from "../config/tenants.js";
import { subirArchivoDrive } from "./drive.service.js";
import { renderizarPdfAImagenes } from "./render.service.js";
import { leerQR } from "./qr.service.js";
import { buscarFilaEnMaestro, encolarEstado, estaEnMantenimiento } from "./excel.service.js";

const RUTA_ENTRADA  = process.env.PATH_ENTRADA_LOCAL;
const RUTA_ENCOLADO = process.env.PATH_ENCOLADO_LOCAL;

const OPCIONES_JOB = {
    attempts: 3,
    backoff: { type: "exponential", delay: 40_000 },
    removeOnComplete: true,
    removeOnFail: false,
};

// ─── Helpers privados ─────────────────────────────────────────────────────────

/**
 * Devuelve true solo cuando el archivo terminó de copiarse al disco.
 * Compara tamaño antes/después de 2 s y verifica que no esté bloqueado.
 */
const archivoEstable = async (rutaArchivo) => {
    try {
        const antes = await fs.stat(rutaArchivo);
        if (antes.size === 0) return false;

        await new Promise((r) => setTimeout(r, 2000));

        const despues = await fs.stat(rutaArchivo);
        if (antes.size !== despues.size) return false;

        // Si el escáner aún escribe, esto lanza EBUSY/EACCES
        const fd = await fs.open(rutaArchivo, "r+");
        await fs.close(fd);
        return true;
    } catch {
        return false;
    }
};

/**
 * Sube el archivo a la carpeta de errores en Drive y lo elimina del disco.
 * Nunca lanza — es una operación best-effort.
 */
const moverADriveErrores = async (rutaLocal, nombreArchivo, motivo) => {
    console.error(`[MONITOR] Error en ${nombreArchivo}: ${motivo}`);
    try {
        if (!(await fs.pathExists(rutaLocal))) return;
        await subirArchivoDrive(await fs.readFile(rutaLocal), nombreArchivo, SYSTEM_FOLDERS.ERRORES);
        await fs.remove(rutaLocal);
    } catch (err) {
        console.error(`[MONITOR] No se pudo subir el archivo de error: ${err.message}`);
    }
};

/**
 * Genera un nombre único: <base>_<timestamp>_<aleatorio>.pdf
 * Evita colisiones si llegan dos PDFs con el mismo nombre.
 */
const generarNombreUnico = (nombreArchivo) => {
    const ext      = path.extname(nombreArchivo);
    const base     = path.basename(nombreArchivo, ext).substring(0, 50);
    const aleatorio = Math.random().toString(36).substring(2, 5).toUpperCase();
    return `${base}_${Date.now()}_${aleatorio}${ext}`;
};

// ─── Procesamiento de un PDF ──────────────────────────────────────────────────

const procesarPdf = async (nombreArchivo) => {
    let rutaLocal  = path.join(RUTA_ENTRADA, nombreArchivo);
    let dirImgTemp = null;

    if (!(await archivoEstable(rutaLocal))) {
        console.log(`[MONITOR] Archivo aún copiándose: ${nombreArchivo}`);
        return;
    }

    // Renombrar para evitar colisiones
    const nombreUnico = generarNombreUnico(nombreArchivo);
    const rutaUnica   = path.join(RUTA_ENTRADA, nombreUnico);
    try {
        await fs.rename(rutaLocal, rutaUnica);
        rutaLocal = rutaUnica;
    } catch (err) {
        console.error(`[MONITOR] No se pudo renombrar ${nombreArchivo}: ${err.message}`);
        // Continuar con el nombre original si el rename falla
    }

    const nombreActual = path.basename(rutaLocal);
    console.log(`\n[MONITOR] Procesando: ${nombreActual}`);

    try {
        if (!(await fs.pathExists(rutaLocal))) {
            throw new Error(`Archivo desapareció: ${rutaLocal}`);
        }

        // 1. Renderizar primera página para leer QR
        dirImgTemp = path.join(PATHS.tempImg, `scan-${Date.now()}`);
        await fs.ensureDir(dirImgTemp);
        await renderizarPdfAImagenes(rutaLocal, dirImgTemp, true);

        const imagenes = (await fs.readdir(dirImgTemp)).sort();
        if (!imagenes.length) throw new Error("Poppler no generó ninguna imagen.");

        // 2. Leer QR de la carátula
        const codigoQR = await leerQR(path.join(dirImgTemp, imagenes[0]));
        if (!codigoQR) {
            await moverADriveErrores(rutaLocal, nombreActual, "SIN_QR");
            return;
        }

        // 3. Buscar en el Maestro
        const idLimpio  = codigoQR.replace(/^"+|"+$/g, "").trim();
        const metadatos = await buscarFilaEnMaestro(idLimpio);
        if (!metadatos) {
            await moverADriveErrores(rutaLocal, nombreActual, `ID_INEXISTENTE: ${idLimpio}`);
            return;
        }

        // 4. Mover a carpeta de encolado y crear job
        const rutaFinal = path.join(RUTA_ENCOLADO, nombreActual);
        await fs.move(rutaLocal, rutaFinal, { overwrite: true });

        const job = await splitQueue.add(
            "split",
            { filePath: rutaFinal, fileName: nombreActual, idCaratula: idLimpio, excelMetadata: metadatos },
            OPCIONES_JOB
        );

        console.log(`[MONITOR] Ticket ${job.id} generado para ${nombreActual}`);
        await encolarEstado(metadatos.rowNumber, `Archivo recibido en cola — ${job.id}`);

    } catch (err) {
        console.error(`[MONITOR] Fallo procesando ${nombreActual}: ${err.message}`);
        await moverADriveErrores(rutaLocal, nombreActual, err.message);
    } finally {
        if (dirImgTemp) await fs.remove(dirImgTemp).catch(() => {});
    }
};

// ─── Ciclo principal ──────────────────────────────────────────────────────────

export const vigilarCarpetaEntrada = async () => {
    if (await estaEnMantenimiento()) {
        console.log("[MONITOR] En pausa por mantenimiento.");
        return;
    }

    await fs.ensureDir(RUTA_ENTRADA);
    await fs.ensureDir(RUTA_ENCOLADO);

    const archivos    = await fs.readdir(RUTA_ENTRADA);
    const archivosPdf = archivos.filter((f) => f.toLowerCase().endsWith(".pdf"));

    for (const nombre of archivosPdf) {
        await procesarPdf(nombre);
    }
};