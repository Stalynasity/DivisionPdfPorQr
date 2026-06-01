import nodeCron from "node-cron";
import { activarMantenimientoRedis, limpiarFilasAntiguas, limpiarExcelsDeApps } from "./excel.service.js";
import { splitQueue } from "../jobs/queue.js";
import { respaldarArchivo, limpiarDriveEnProfundidad } from "./drive.service.js";

const TIMEOUT_DRENADO_MS = 30 * 60 * 1000; // 30 min máximo esperando que vacíe la cola
const INTERVALO_SONDEO_MS = 15_000;

const CARPETAS_CARATULAS = [
    process.env.CARPETA_CARATULAS_PDF_1,
    process.env.CARPETA_CARATULAS_PDF_2,
    process.env.CARPETA_CARATULAS_PDF_3,
    process.env.CARPETA_CARATULAS_PDF_4,
].filter(Boolean);

const CARPETAS_PDF_COMPLETO = [
    process.env.DOCUMENTOS_COMPLETOS_PROCESADOS_FOLDER_ID,
].filter(Boolean);

// ─── Pasos de mantenimiento ───────────────────────────────────────────────────

/** Espera hasta que la cola BullMQ esté vacía, con un timeout máximo. */
const esperarColaVacia = async () => {
    const inicio = Date.now();

    while (true) {
        const { wait, active } = await splitQueue.getJobCounts("wait", "active");
        if (wait + active === 0) break;

        if (Date.now() - inicio > TIMEOUT_DRENADO_MS) {
            console.warn("[MANTENIMIENTO] Timeout de drenado alcanzado. Continuando de todas formas.");
            break;
        }

        console.log(`[MANTENIMIENTO] Esperando: ${wait} en cola, ${active} activos...`);
        await new Promise((r) => setTimeout(r, INTERVALO_SONDEO_MS));
    }
};

const registrarEstadisticasLimpieza = (etiqueta, stats) =>
    console.log(`[MANTENIMIENTO] ${etiqueta}: ${stats.archivosBorrados} archivos y ${stats.carpetasBorradas} carpetas eliminadas.`);

// ─── Ciclo principal ──────────────────────────────────────────────────────────

const ejecutarMantenimiento = async () => {
    console.log("\n[MANTENIMIENTO] ── Iniciando ventana semanal ──");
    await activarMantenimientoRedis(true);

    try {
        await esperarColaVacia();

        console.log("[MANTENIMIENTO] Creando backup del Maestro...");
        await respaldarArchivo(process.env.EXCEL_DIGITALIZACION);

        console.log("[MANTENIMIENTO] Limpiando registros antiguos en Maestro...");
        await limpiarFilasAntiguas();

        console.log("[MANTENIMIENTO] Limpiando Excels de Apps...");
        await limpiarExcelsDeApps();

        console.log("[MANTENIMIENTO] Limpiando carátulas en Drive (>21 días)...");
        registrarEstadisticasLimpieza("Carátulas", await limpiarDriveEnProfundidad(CARPETAS_CARATULAS, 21));

        console.log("[MANTENIMIENTO] Limpiando PDFs completos en Drive (>30 días)...");
        registrarEstadisticasLimpieza("PDFs completos", await limpiarDriveEnProfundidad(CARPETAS_PDF_COMPLETO, 30));

    } catch (err) {
        console.error(`[MANTENIMIENTO] Error crítico: ${err.message}`);
    } finally {
        await activarMantenimientoRedis(false);
        console.log("[MANTENIMIENTO] ── Finalizado, sistema reabierto ──\n");
    }
};

// ─── Scheduler ────────────────────────────────────────────────────────────────

export const iniciarSchedulerMantenimiento = () => {
    nodeCron.schedule("0 17 * * 0", ejecutarMantenimiento);
    console.log("[MANTENIMIENTO] Scheduler semanal inicializado (Domingos 17:00)");
};