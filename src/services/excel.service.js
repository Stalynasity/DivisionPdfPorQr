import { google } from "googleapis";
import { getOAuthClient } from "./auth.service.js";
import Redis from "ioredis";
import { connection } from "../config/redis.js";
import { respaldarArchivo } from "./drive.service.js";
import dotenv from "dotenv";

dotenv.config();

// ─── Clientes ─────────────────────────────────────────────────────────────────

const redis = new Redis(connection);

let clienteSheets;
const obtenerClienteSheets = async () => {
    if (!clienteSheets) {
        const auth = await getOAuthClient();
        clienteSheets = google.sheets({ version: "v4", auth });
    }
    return clienteSheets;
};

// ─── Constantes ───────────────────────────────────────────────────────────────

const SPREADSHEET_ID = process.env.EXCEL_DIGITALIZACION;
const HOJA_MAESTRO = process.env.SHEET_NAME_MAESTRO;
const HOJA_DRIVE = process.env.SHEET_NAME_DRIVE ?? "Archivos_Drive";

const CLAVE_ESTADO = "excel_status_buffer";
const PREFIJO_BATCH = "excel_buffer:";
const CLAVE_MANTENIMIENTO = "system:maintenance_mode";

const CONFIG_TABLAS = {
    maestro: { id: SPREADSHEET_ID, hoja: HOJA_MAESTRO },
    monitoreo: { id: process.env.EXCEL_MONITOREO_ID, hoja: process.env.SHEET_NAME_MONITOREO },
};

const DIAS_EN_MS = (d) => d * 24 * 60 * 60 * 1000;

// ─── Helpers privados ─────────────────────────────────────────────────────────

/** Convierte un índice de columna 0-based a su letra (0 → A, 26 → AA). */
const indiceALetra = (indice) => {
    let letra = "";
    let i = indice;
    while (i >= 0) {
        letra = String.fromCharCode(65 + (i % 26)) + letra;
        i = Math.floor(i / 26) - 1;
    }
    return letra;
};

/** Busca una columna por nombre en la cabecera y devuelve su letra. */
const resolverLetraColumna = async (spreadsheetId, nombreHoja, nombreColumna) => {
    const sheets = await obtenerClienteSheets();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${nombreHoja}!1:1` });
    const cabecera = res.data.values?.[0] ?? [];
    const idx = cabecera.indexOf(nombreColumna);

    if (idx === -1) throw new Error(`COLUMNA_NO_ENCONTRADA: "${nombreColumna}" en "${nombreHoja}"`);
    return indiceALetra(idx);
};

/** Vacía una hoja y la reescribe por bloques de 5000 filas. */
const reescribirHoja = async (spreadsheetId, nombreHoja, filas) => {
    const sheets = await obtenerClienteSheets();
    const BLOQUE = 5_000;

    await sheets.spreadsheets.values.clear({ spreadsheetId, range: nombreHoja });

    for (let i = 0; i < filas.length; i += BLOQUE) {
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${nombreHoja}!A${i + 1}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: filas.slice(i, i + BLOQUE) },
        });
    }
};

/** Parsea "YYYY-MM-DD HH:MM:SS" o "DD/MM/YYYY HH:MM:SS" → Date | null. */
const parsearFecha = (raw) => {
    if (!raw || typeof raw !== "string") return null;
    try {
        const [parteDate, parteTime = "00:00:00"] = raw.trim().split(" ");
        let dia, mes, anio;

        if (parteDate.includes("-")) [anio, mes, dia] = parteDate.split("-").map(Number);
        else if (parteDate.includes("/")) [dia, mes, anio] = parteDate.split("/").map(Number);
        else return null;

        const [h, m, s] = parteTime.split(":").map(Number);
        const fecha = new Date(anio, mes - 1, dia, h, m, s);
        return isNaN(fecha.getTime()) ? null : fecha;
    } catch {
        return null;
    }
};

/** Resuelve el spreadsheetId de una App desde las variables de entorno. */
const obtenerIdHojaApp = (appAsignada) => {
    const clave = `${appAsignada.replace("-", "")}_EXCEL_ARCHIVOS_DRIVE_ID`;
    const id = process.env[clave];
    if (!id) throw new Error(`APP_NO_CONFIGURADA: ${appAsignada} (falta ${clave})`);
    return id;
};

// ─── Modo mantenimiento ───────────────────────────────────────────────────────

export const activarMantenimientoRedis = async (valor) => {
    await redis.set(CLAVE_MANTENIMIENTO, valor ? "true" : "false");
    console.log(`[REDIS] Mantenimiento: ${valor ? "ACTIVADO" : "DESACTIVADO"}`);
};

export const estaEnMantenimiento = async () =>
    (await redis.get(CLAVE_MANTENIMIENTO)) === "true";

// ─── Colas Redis ──────────────────────────────────────────────────────────────

/** Encola una actualización de celda genérica (cualquier columna). */
export const encolarActualizacionCelda = async (numeroFila, nombreColumna, valor) => {
    if (!numeroFila) return;
    await redis.rpush(CLAVE_ESTADO, JSON.stringify({ rowNumber: numeroFila, columnName: nombreColumna, value: valor }));
};

/** Encola una actualización de Estado_Carga específicamente. */
export const encolarEstado = (numeroFila, valor) =>
    encolarActualizacionCelda(numeroFila, "Estado_Carga", valor);

/** Encola filas de documentos para inserción masiva en el próximo ciclo batch. */
export const encolarFilasDocumentos = async (filas, appAsignada) => {
    if (!filas?.length) return;
    const pipeline = redis.pipeline();
    filas.forEach((fila) => pipeline.rpush(`${PREFIJO_BATCH}${appAsignada}`, JSON.stringify(fila)));
    await pipeline.exec();
    console.log(`[REDIS] ${filas.length} filas encoladas para ${appAsignada}`);
};

// ─── Google Sheets: Lectura ───────────────────────────────────────────────────

/**
 * Busca una fila en el Maestro por ID_Caratula.
 * @returns {object|null} Objeto con los headers como claves + { rowNumber }
 */
export const buscarFilaEnMaestro = async (idBusqueda) => {
    const sheets = await obtenerClienteSheets();
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${HOJA_MAESTRO}!A:AZ`,
    });

    const filas = res.data.values;
    if (!filas?.length) return null;

    const cabecera = filas[0];
    const idxColId = cabecera.indexOf("ID_Caratula");
    const idLimpio = String(idBusqueda).trim().toLowerCase();

    const idxFila = filas.findIndex(
        (fila, i) => i > 0 && String(fila[idxColId] ?? "").trim().toLowerCase() === idLimpio
    );

    if (idxFila === -1) return null;

    return cabecera.reduce(
        (acc, col, i) => { acc[col] = filas[idxFila][i] ?? ""; return acc; },
        { rowNumber: idxFila + 1 }
    );
};

// ─── Google Sheets: Escritura ─────────────────────────────────────────────────

/** Inserta filas en el Excel de una App con reintentos exponenciales ante cuotas. */
export const insertarFilasEnLote = async (filas, appAsignada) => {
    if (!filas?.length) return;

    const sheets = await obtenerClienteSheets();
    const spreadsheetId = obtenerIdHojaApp(appAsignada);
    const MAX_INTENTOS = 3;
    let espera = 2_000;

    for (let intento = 0; intento < MAX_INTENTOS; intento++) {
        try {
            await sheets.spreadsheets.values.append({
                spreadsheetId,
                range: `${HOJA_DRIVE}!A:G`,
                valueInputOption: "USER_ENTERED",
                requestBody: { values: filas },
            });
            return;
        } catch (err) {
            const esQuota = err.code === 429 || err.message?.includes("quota");
            if (esQuota && intento < MAX_INTENTOS - 1) {
                console.warn(`[SHEETS] Cuota alcanzada — reintentando en ${espera / 1000}s (${intento + 1}/${MAX_INTENTOS})`);
                await new Promise((r) => setTimeout(r, espera));
                espera *= 2;
            } else {
                throw err;
            }
        }
    }
};

/** Actualiza un lote de celdas en una misma columna con una sola llamada a la API. */
export const actualizarCeldasEnLote = async (actualizaciones, tabla, nombreColumna) => {
    if (!actualizaciones?.length) return;

    const config = CONFIG_TABLAS[tabla];
    if (!config) throw new Error(`TABLA_INVALIDA: ${tabla}`);

    const sheets = await obtenerClienteSheets();
    const letra = await resolverLetraColumna(config.id, config.hoja, nombreColumna);

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: config.id,
        requestBody: {
            valueInputOption: "USER_ENTERED",
            data: actualizaciones.map((u) => ({
                range: `${config.hoja}!${letra}${u.rowNumber}`,
                values: [[u.value]],
            })),
        },
    });
};

// ─── Mantenimiento: Limpieza ──────────────────────────────────────────────────

/** Elimina filas antiguas del Maestro según reglas de negocio. */
export const limpiarFilasAntiguas = async () => {
    const sheets = await obtenerClienteSheets();
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${HOJA_MAESTRO}!A:AZ`,
    });

    const filas = res.data.values;
    if (!filas || filas.length <= 1) return;

    const cab = filas[0];
    const idxFecha = cab.indexOf("Fecha_creacion");
    const idxId = cab.indexOf("ID_Caratula");
    const idxEstado = cab.indexOf("Estado_Carga");
    const hoy = new Date();

    const conservadas = filas.filter((fila, i) => {
        if (i === 0) return true;
        if (!String(fila[idxId] ?? "").trim()) return false;

        const fecha = parsearFecha(fila[idxFecha]);
        if (!fecha) return true;

        const limite = String(fila[idxEstado] ?? "").includes("CARATULA CREADA")
            ? DIAS_EN_MS(21)
            : DIAS_EN_MS(30);

        return (hoy - fecha) < limite;
    });

    if (conservadas.length === filas.length) return;

    await reescribirHoja(SPREADSHEET_ID, HOJA_MAESTRO, conservadas);
    console.log(`[LIMPIEZA] Maestro: ${filas.length} → ${conservadas.length} filas.`);
};

/** Elimina filas antiguas de los Excels de cada App (descubiertos desde .env). */
export const limpiarExcelsDeApps = async () => {
    const sheets = await obtenerClienteSheets();
    const hoy = new Date();
    const limite = DIAS_EN_MS(21);

    const appsConfiguradas = Object.entries(process.env).filter(([k]) =>
        /^APP\d+_EXCEL_ARCHIVOS_DRIVE_ID$/.test(k)
    );

    for (const [clave, spreadsheetId] of appsConfiguradas) {
        try {
            console.log(`\n[LIMPIEZA-APPS] ${clave}...`);

            const res = await sheets.spreadsheets.values.get({
                spreadsheetId,
                range: `${HOJA_DRIVE}!A:Z`,
            });

            const filas = res.data.values;
            if (!filas || filas.length <= 1) { console.log("[SKIP] Sin datos."); continue; }

            const idxFecha = filas[0].indexOf("FECHA_CREACION");
            if (idxFecha === -1) {
                console.warn(`[WARN] Sin columna FECHA_CREACION en ${clave}.`);
                continue;
            }

            const conservadas = filas.filter((fila, i) => {
                if (i === 0) return true;
                const fecha = parsearFecha(fila[idxFecha]);
                if (!fecha) return true;
                return (hoy - fecha) <= limite;
            });

            // Guardia antiborrado masivo: si solo queda el header con muchos datos originales,
            // probablemente el formato de fecha cambió en Google Sheets
            if (conservadas.length === 1 && filas.length > 5) {
                console.error(`[!] ABORTADO: posible borrado masivo en ${clave}. Revise el formato de fecha.`);
                continue;
            }

            if (conservadas.length === filas.length) {
                console.log(`[INFO] Sin filas antiguas en ${clave}.`);
                continue;
            }

            await respaldarArchivo(spreadsheetId, "BACKUPS_ARCHIVOS_DRIVE");
            await reescribirHoja(spreadsheetId, HOJA_DRIVE, conservadas);
            console.log(`[LIMPIEZA] ${clave}: ${filas.length} → ${conservadas.length} filas.`);

        } catch (err) {
            console.error(`[ERROR] ${clave}: ${err.message}`);
        }
    }
};