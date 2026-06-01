import fs from "fs-extra";
import path from "path";
import { Worker } from "bullmq";
import { connection } from "../config/redis.js";
import { dividirPdf } from "../services/split.service.js";
import { obtenerOCrearRutaCarpeta, subirArchivoDrive } from "../services/drive.service.js";
import { encolarEstado, estaEnMantenimiento } from "../services/excel.service.js";
import { SYSTEM_FOLDERS } from "../config/tenants.js";
import dotenv from "dotenv";

dotenv.config();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sube el archivo al Drive de errores para inspección manual.
 * Best-effort: nunca lanza, la recuperación no debe romper el flujo.
 */
const moverADriveErrores = async (rutaArchivo, nombreArchivo) => {
    try {
        if (!(await fs.pathExists(rutaArchivo))) return;
        const buffer = await fs.readFile(rutaArchivo);
        await subirArchivoDrive(buffer, `ERROR_${nombreArchivo}`, SYSTEM_FOLDERS.ERRORES);
        console.log(`[WORKER] Respaldado en Drive/ERRORES: ${nombreArchivo}`);
    } catch (err) {
        console.error(`[WORKER] Falló el respaldo: ${err.message}`);
    }
};

const guardarMetadatosLocales = async (idSof, jobId, nombreArchivo, resultado, metadatos) => {
    const dir      = path.resolve(process.env.Local_metadata ?? "metadata");
    const nombre   = idSof.replace(/[^a-z0-9]/gi, "-");
    const rutaJson = path.join(dir, `meta_${nombre}.json`);

    await fs.ensureDir(dir);
    await fs.writeJson(rutaJson, { jobId, originalFileName: nombreArchivo, resultMetadata: resultado, clienteData: metadatos }, { spaces: 2 });
    return rutaJson;
};

/**
 * Construye el ID SOF desde los metadatos.
 * Formato: CAR_<iniciales><sufijo>-<identificacion>
 */
const construirIdSof = (metadatos) => {
    const sufijo    = String(metadatos.ID_Caratula).split("_").pop() ?? "NULL";
    const iniciales = metadatos.Usuario.split(".").map((p) => p[0]).join("").toUpperCase();
    return `CAR_${iniciales}${sufijo}-${metadatos.No_Identificacion}`;
};

// ─── Procesador ───────────────────────────────────────────────────────────────

const procesador = async (job) => {
    if (await estaEnMantenimiento()) {
        throw new Error("WAIT_MAINTENANCE: sistema en ventana de mantenimiento.");
    }

    const { filePath, fileName, idCaratula, excelMetadata: metadatos } = job.data;
    const logId           = `TICKET:${job.id} | ID:${idCaratula}`;
    const maxIntentos     = job.opts.attempts ?? 3;
    const esIntentoFinal  = job.attemptsMade + 1 >= maxIntentos;

    if (!(await fs.pathExists(filePath))) {
        throw new Error(`ARCHIVO_NO_ENCONTRADO: ${filePath}`);
    }

    if (!metadatos) {
        console.warn(`[WORKER] Sin metadatos — ${logId}`);
        await moverADriveErrores(filePath, fileName);
        return { status: "skipped_no_metadata" };
    }

    try {
        // 1. Resolver carpeta destino en Drive
        const carpetaDestino = await obtenerOCrearRutaCarpeta(
            process.env.ID_CARPETA_DIGITALIZADOS,
            [
                metadatos.Usuario           ?? "SIN_USUARIO",
                metadatos.No_Identificacion ?? "1000000000",
                metadatos.Proceso           ?? "GENERAL",
            ]
        );

        // 2. Dividir el PDF
        console.log(`[WORKER] Procesando — ${logId}`);
        const resultado = await dividirPdf(filePath, job.id, carpetaDestino, metadatos);

        // 3. Guardar metadatos locales y notificar éxito
        const idSof    = construirIdSof(metadatos);
        const rutaJson = await guardarMetadatosLocales(idSof, job.id, fileName, resultado, metadatos);

        await encolarEstado(metadatos.rowNumber, `PROCESO FINALIZADO | ID_SOF: ${idSof}`);
        await fs.remove(filePath);

        console.log(`[WORKER] Éxito — ${logId}`);
        return { status: "success", path: rutaJson };

    } catch (err) {
        const intento = job.attemptsMade + 1;
        console.error(`[WORKER] Fallo — ${logId} | Intento ${intento}/${maxIntentos}: ${err.message}`);

        // PDF sin separadores QR → no tiene sentido reintentar
        if (err.message === "NO_CATEGORIES_FOUND") {
            await encolarEstado(metadatos.rowNumber, "PDF sin separadores válidos");
            await moverADriveErrores(filePath, fileName);
            return { status: "failed_no_categories" };
        }

        if (esIntentoFinal) {
            await moverADriveErrores(filePath, fileName);
            await encolarEstado(metadatos.rowNumber, `Error definitivo: ${err.message.substring(0, 100)}`);
        } else {
            const motivo = err.message.includes("hang up") ? "Conexión saturada" : "Error de red";
            await encolarEstado(metadatos.rowNumber, `Reintentando (${motivo}) ${intento}/${maxIntentos}...`);
        }

        throw err;
    }
};

// ─── Worker ───────────────────────────────────────────────────────────────────

const worker = new Worker("splitQueue", procesador, {
    connection,
    concurrency: 2,
    lockDuration: 900_000,
    removeOnComplete: { count: 700 },
    removeOnFail:     { count: 100 },
});

worker.on("failed", (job, err) =>
    console.error(`[BULLMQ] Job fallido — Ticket: ${job?.id} | ${err.message}`)
);
worker.on("error", (err) =>
    console.error(`[BULLMQ] Error Redis — ${err.message}`)
);

// ─── Apagado limpio ───────────────────────────────────────────────────────────

let apagando = false;

const apagarLimpiamente = async (señal) => {
    if (apagando) return;
    apagando = true;
    console.log(`\n[WORKER] Señal ${señal} — cerrando...`);
    try {
        await worker.close();
        console.log("[WORKER] Cerrado limpiamente.");
    } catch (err) {
        console.error(`[WORKER] Error al cerrar: ${err.message}`);
    }
    process.exit(0);
};

process.on("SIGTERM", () => apagarLimpiamente("SIGTERM"));
process.on("SIGINT",  () => apagarLimpiamente("SIGINT"));