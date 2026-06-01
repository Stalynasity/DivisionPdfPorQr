import Redis from "ioredis";
import { connection } from "../config/redis.js";
import { insertarFilasEnLote, actualizarCeldasEnLote } from "./excel.service.js";

const redis = new Redis(connection);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Lee y vacía atómicamente una lista Redis.
 * Retorna los elementos parseados, o [] si estaba vacía.
 */
const vaciarLista = async (clave) => {
    const [[, items]] = await redis.multi().lrange(clave, 0, -1).del(clave).exec();
    return items?.length ? items.map(JSON.parse) : [];
};

// ─── Ciclos de flush ──────────────────────────────────────────────────────────

/**
 * Cada 60 s: vuelca filas pendientes de cada App a Google Sheets (append).
 */
const vaciarBufferInsercion = async () => {
    const claves = await redis.keys("excel_buffer:APP-*");

    for (const clave of claves) {
        const appName = clave.split(":")[1];
        const filas   = await vaciarLista(clave);
        if (!filas.length) continue;

        console.log(`[BATCH-APPEND] ${filas.length} filas → ${appName}`);
        await insertarFilasEnLote(filas, appName);
    }
};

/**
 * Cada 10 s: vuelca actualizaciones de celdas a Google Sheets (batchUpdate),
 * agrupadas por columna para minimizar llamadas a la API.
 */
const vaciarBufferEstado = async () => {
    const actualizaciones = await vaciarLista("excel_status_buffer");
    if (!actualizaciones.length) return;

    const porColumna = actualizaciones.reduce((acumulador, item) => {
        const nombreCol = item.columnName ?? "Estado_Carga";
        if (!acumulador[nombreCol]) {
            acumulador[nombreCol] = [];
        }
        acumulador[nombreCol].push(item);
        return acumulador;
    }, {});

    // Recorremos el objeto agrupado (usando Object.entries para obtener nombreCol y items)
    for (const [nombreCol, items] of Object.entries(porColumna)) {
        console.log(`[BATCH-UPDATE] ${items.length} celdas → columna [${nombreCol}]`);
        await actualizarCeldasEnLote(items, "maestro", nombreCol);
    }
};

// ─── Punto de entrada ─────────────────────────────────────────────────────────

export const iniciarCiclosBatch = () => {
    console.log("[BATCH] Sistema de batching iniciado");
    setInterval(() => vaciarBufferInsercion().catch((e) => console.error("[BATCH-APPEND]", e.message)), 60_000);
    setInterval(() => vaciarBufferEstado().catch((e) => console.error("[BATCH-UPDATE]", e.message)), 10_000);
};