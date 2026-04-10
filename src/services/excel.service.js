import { google } from "googleapis";
import { getOAuthClient } from "./auth.oauth.js";
import dotenv from "dotenv";
import Redis from "ioredis";
import { connection } from "../config/redis.js";
import { backupFile } from "./drive.service.js";

dotenv.config();

// ============================================================================
// 1. CONFIGURACIÓN Y CLIENTES (Single Responsibility)
// ============================================================================

const redisClient = new Redis(connection);
const BATCH_KEY_PREFIX = "excel_buffer:";
const STATUS_KEY_PREFIX = "excel_status_buffer";
const MAINTENANCE_KEY = "system:maintenance_mode";

const SPREADSHEET_ID = process.env.EXCEL_DIGITALIZACION;
const SPREADSHEET_ID_MONITOREO = process.env.EXCEL_MONITOREO_ID;
const SHEET_NAME_MAESTRO = process.env.SHEET_NAME_MAESTRO;

let sheetsInstance;

const getSheetsClient = async () => {
    if (!sheetsInstance) {
        const auth = await getOAuthClient();
        sheetsInstance = google.sheets({ version: "v4", auth });
    }
    return sheetsInstance;
};

// Configuración de las tablas principales
const TABLE_CONFIG = {
    monitoreo: { id: SPREADSHEET_ID_MONITOREO, sheet: process.env.SHEET_NAME_MONITOREO },
    maestro: { id: SPREADSHEET_ID, sheet: SHEET_NAME_MAESTRO }
};

/**
 * Encola una actualización para CUALQUIER celda/columna en Redis
 */
export const enqueueCellUpdate = async (rowNumber, columnName, value) => {
    if (!rowNumber) return;
    await redisClient.rpush(STATUS_KEY_PREFIX, JSON.stringify({ rowNumber, columnName, value }));
};

/**
 * Persiste el estado de mantenimiento en Redis
 */
export const setMaintenanceRedis = async (value) => {
    await redisClient.set(MAINTENANCE_KEY, value ? "true" : "false");
    console.log(`[REDIS] Modo Mantenimiento actualizado a: ${value}`);
};

/**
 * Obtiene el estado de mantenimiento desde Redis
 */
export const getMaintenanceRedis = async () => {
    const status = await redisClient.get(MAINTENANCE_KEY);
    return status === "true";
};

// ============================================================================
// 2. HELPERS Y UTILIDADES (DRY - Don't Repeat Yourself)
// ============================================================================

/**
 * Resuelve dinámicamente el ID del Excel según la App (Open/Closed Principle)
 */
const getAppSpreadsheetId = (appAsignada) => {
    // Si la variable viene como APP-1, busca en process.env["APP1_EXCEL_ARCHIVOS_DRIVE_ID"]
    const envKey = `${appAsignada.replace("-", "")}_EXCEL_ARCHIVOS_DRIVE_ID`;
    const spreadsheetId = process.env[envKey];
    
    if (!spreadsheetId) throw new Error(`APP_NOT_CONFIGURED: ${appAsignada} (Falta variable ${envKey})`);
    return spreadsheetId;
};

/**
 * Convierte el nombre de una columna en su letra correspondiente (Ej: "Estado" -> "C")
 */
const getColumnLetterByName = async (spreadsheetId, sheetName, columnName) => {
    const sheets = await getSheetsClient();
    
    const headerRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!1:1`,
    });

    const headers = headerRes.data.values?.[0] || [];
    const colIndex = headers.indexOf(columnName);
    
    if (colIndex === -1) throw new Error(`COLUMN_NOT_FOUND: ${columnName} en ${sheetName}`);

    // Algoritmo robusto para letras de columna (soporta AA, AB, etc.)
    let temp = colIndex;
    let colLetter = '';
    while (temp >= 0) {
        colLetter = String.fromCharCode(65 + (temp % 26)) + colLetter;
        temp = Math.floor(temp / 26) - 1;
    }
    
    return colLetter;
};

const parseCustomDate = (dateString) => {
    if (!dateString || typeof dateString !== 'string') return null;
    
    try {
        // Divide "2026-02-12 20:59:01" en ["2026-02-12", "20:59:01"]
        const parts = dateString.trim().split(' ');
        const datePart = parts[0];
        const timePart = parts[1] || "00:00:00";

        let day, month, year;

        if (datePart.includes('-')) {
            // Formato YYYY-MM-DD (el de tu imagen)
            [year, month, day] = datePart.split('-').map(Number);
        } else if (datePart.includes('/')) {
            // Formato DD/MM/YYYY
            [day, month, year] = datePart.split('/').map(Number);
        } else {
            return null;
        }

        const [hour, minute, second] = timePart.split(':').map(Number);
        
        // El mes en JS es 0-11
        const dateObj = new Date(year, month - 1, day, hour, minute, second);
        
        return isNaN(dateObj.getTime()) ? null : dateObj;
    } catch (error) {
        return null;
    }
};

// ============================================================================
// 3. SISTEMA DE COLAS Y BUFFERS EN REDIS (Alta Velocidad)
// ============================================================================

export const enqueueDocumentRows = async (rowsArray, appAsignada) => {
    if (!rowsArray || rowsArray.length === 0) return;
    
    const key = `${BATCH_KEY_PREFIX}${appAsignada}`;
    const pipeline = redisClient.pipeline();
    
    rowsArray.forEach(row => pipeline.rpush(key, JSON.stringify(row)));
    await pipeline.exec();
    
    console.log(`[REDIS] Encolados ${rowsArray.length} registros de documentos para ${appAsignada}`);
};

export const enqueueStatusUpdate = async (rowNumber, value) => {
    await enqueueCellUpdate(rowNumber, "Estado_Carga", value);
};

// ============================================================================
// 4. LÓGICA DE NEGOCIO (Google Sheets API)
// ============================================================================

export const getDataFromExcel = async (idBusqueda) => {
    try {
        const sheets = await getSheetsClient();
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME_MAESTRO}!A:AZ`,
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) return null;

        const headers = rows[0];
        const idColIndex = headers.indexOf("ID_Caratula");
        const cleanId = String(idBusqueda).trim().toLowerCase();

        const rowIndex = rows.findIndex((row, idx) => 
            idx > 0 && String(row[idColIndex] ?? "").trim().toLowerCase() === cleanId
        );

        if (rowIndex === -1) return null;

        return headers.reduce((acc, header, index) => {
            acc[header] = rows[rowIndex][index] || "";
            return acc;
        }, { rowNumber: rowIndex + 1 });

    } catch (error) {
        console.error(`ERROR: SHEETS_FETCH_FAILED - ID: ${idBusqueda} | Msg: ${error.message}`);
        throw error;
    }
};

export const insertDocumentRowsBatch = async (rowsArray, appAsignada, retries = 3, delay = 2000) => {
    if (!rowsArray || rowsArray.length === 0) return;

    for (let i = 0; i < retries; i++) {
        try {
            const sheets = await getSheetsClient();
            const spreadsheetId = getAppSpreadsheetId(appAsignada); // Usamos el helper dinámico
            const sheetName = process.env.SHEET_NAME_DRIVE || "Archivos_Drive";

            await sheets.spreadsheets.values.append({
                spreadsheetId,
                range: `${sheetName}!A:G`,
                valueInputOption: "USER_ENTERED",
                requestBody: { values: rowsArray }
            });

            return; // Éxito, salimos del bucle

        } catch (error) {
            const isRateLimit = error.code === 429 || error.message.includes('quota');
            if (isRateLimit && i < retries - 1) {
                console.warn(`WARN: SHEETS_QUOTA_HIT - Reintentando en ${delay/1000}s (Intento ${i+1}/${retries})`);
                await new Promise(res => setTimeout(res, delay));
                delay *= 2;
            } else {
                console.error(`ERROR: SHEETS_APPEND_FAILED - App: ${appAsignada} | Msg: ${error.message}`);
                throw error;
            }
        }
    }
};

export const batchUpdateSheetRows = async (updates, Tabla, columnName) => {
    if (!updates || updates.length === 0) return;

    try {
        const target = TABLE_CONFIG[Tabla];
        if (!target) throw new Error(`INVALID_TABLE: ${Tabla}`);

        const sheets = await getSheetsClient();
        
        // 1. Usamos el helper centralizado para evitar código duplicado
        const colLetter = await getColumnLetterByName(target.id, target.sheet, columnName);

        // 2. Construir Data
        const dataToUpdate = updates.map(u => ({
            range: `${target.sheet}!${colLetter}${u.rowNumber}`,
            values: [[u.value]]
        }));

        // 3. Ejecutar Batch
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: target.id,
            requestBody: {
                valueInputOption: "USER_ENTERED",
                data: dataToUpdate 
            }
        });

    } catch (error) {
        console.error(`ERROR: SHEETS_BATCH_UPDATE_FAILED - Col: ${columnName}`, error?.response?.data || error.message);
        throw error; 
    }
};

export const updateSheetRow = async (rowNumber, Tabla, columnName, value) => {
    try {
        const target = TABLE_CONFIG[Tabla];
        if (!target) throw new Error(`INVALID_TABLE: ${Tabla}`);

        const sheets = await getSheetsClient();
        
        // Usamos el mismo helper de arriba (DRY)
        const colLetter = await getColumnLetterByName(target.id, target.sheet, columnName);
        const range = `${target.sheet}!${colLetter}${rowNumber}`;

        await sheets.spreadsheets.values.update({
            spreadsheetId: target.id,
            range: range,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[value]] }
        });

    } catch (error) {
        console.error(`ERROR: SHEETS_UPDATE_FAILED - Table: ${Tabla} | Col: ${columnName} | Msg: ${error.message}`);
        throw error;
    }
};

export const cleanOldRows = async () => {
    try {
        const sheets = await getSheetsClient();
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME_MAESTRO}!A:AZ`,
        });

        const rows = res.data.values;
        if (!rows || rows.length <= 1) return;

        const headers = rows[0];
        const fechaIdx = headers.indexOf("Fecha_creacion");
        const idCaratulaIdx = headers.indexOf("ID_Caratula");
        const estadoCargaIdx = headers.indexOf("Estado_Carga");

        const hoy = new Date();
        const limite21Dias = 21 * 24 * 60 * 60 * 1000;
        const limite30Dias = 30 * 24 * 60 * 60 * 1000; // 1 mes aproximado

        const filasConservadas = rows.filter((row, idx) => {
            if (idx === 0) return true; // Encabezado

            // 1. Eliminar si el ID está vacío
            const idValue = row[idCaratulaIdx];
            if (!idValue || String(idValue).trim() === "") return false;

            const estado = String(row[estadoCargaIdx] || "").trim();
            const fechaFila = parseCustomDate(row[fechaIdx]);
            
            // Si no hay fecha, por seguridad lo dejamos (o podrías decidir borrarlo)
            if (!fechaFila) return true;

            const antiguedad = hoy - fechaFila;

            // 2. REGLA DE ÉXITO: Si no cambia de caratula creada, se borra a los 21 días. Si cambia, se le da un mes.
            if (estado.includes("CARATULA CREADA")) {
                return antiguedad < limite21Dias;
            }

            return antiguedad < limite30Dias;
        });

        if (rows.length !== filasConservadas.length) {
            // BACKUP (Llamado desde el scheduler antes de esta función)
            
            await sheets.spreadsheets.values.clear({
                spreadsheetId: SPREADSHEET_ID,
                range: SHEET_NAME_MAESTRO,
            });

            const CHUNK_SIZE = 5000;
            for (let i = 0; i < filasConservadas.length; i += CHUNK_SIZE) {
                const chunk = filasConservadas.slice(i, i + CHUNK_SIZE);
                await sheets.spreadsheets.values.update({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `${SHEET_NAME_MAESTRO}!A${i + 1}`,
                    valueInputOption: "USER_ENTERED",
                    requestBody: { values: chunk }
                });
            }
            console.log(`[CLEANUP] Finalizado. Filas originales: ${rows.length}, Conservadas: ${filasConservadas.length}`);
        }
    } catch (error) {
        console.error(`ERROR: CLEANUP_FAILED - ${error.message}`);
        throw error;
    }
};

export const cleanAppDriveExcels = async () => {
    const APP_ENV_KEYS = [
        "APP1_EXCEL_ARCHIVOS_DRIVE_ID", "APP2_EXCEL_ARCHIVOS_DRIVE_ID", 
        "APP3_EXCEL_ARCHIVOS_DRIVE_ID", "APP4_EXCEL_ARCHIVOS_DRIVE_ID", 
        "APP5_EXCEL_ARCHIVOS_DRIVE_ID", "APP6_EXCEL_ARCHIVOS_DRIVE_ID", 
        "APP7_EXCEL_ARCHIVOS_DRIVE_ID", "APP8_EXCEL_ARCHIVOS_DRIVE_ID", 
        "APP9_EXCEL_ARCHIVOS_DRIVE_ID", "APP10_EXCEL_ARCHIVOS_DRIVE_ID"
    ];

    const sheets = await getSheetsClient();
    const hoy = new Date();
    // Definimos el límite de 21 días exactos
    const limiteMs = 21 * 24 * 60 * 60 * 1000;
    const sheetName = process.env.SHEET_NAME_DRIVE || "Archivos_Drive";

    for (const envKey of APP_ENV_KEYS) {
        try {
            const spreadsheetId = process.env[envKey];
            if (!spreadsheetId) continue;

            console.log(`\n[CLEANUP-APPS] Analizando ${envKey}...`);

            const res = await sheets.spreadsheets.values.get({
                spreadsheetId,
                range: `${sheetName}!A:Z`,
            });

            const rows = res.data.values;
            if (!rows || rows.length <= 1) {
                console.log(`[SKIP] ${envKey} no tiene datos para procesar.`);
                continue;
            }

            const headers = rows[0];
            const fechaIdx = headers.indexOf("FECHA_CREACION");

            if (fechaIdx === -1) {
                console.warn(`[WARN] No se encontró la columna FECHA_CREACION en ${envKey}.`);
                continue;
            }

            // --- FILTRADO SEGURO ---
            const filasConservadas = rows.filter((row, idx) => {
                if (idx === 0) return true; // Siempre conservar encabezados

                const valorFechaRaw = row[fechaIdx];
                if (!valorFechaRaw) return true; // Si no hay fecha, no borramos por precaución

                const fechaFila = parseCustomDate(valorFechaRaw);
                
                // VALIDACIÓN CRÍTICA: Si el parseo falla (null o inválida), CONSERVAMOS.
                if (!fechaFila || isNaN(fechaFila.getTime())) {
                    return true; 
                }

                const antiguedadMs = hoy - fechaFila;

                // Conservar solo si la antigüedad es MENOR o IGUAL a 21 días.
                return antiguedadMs <= limiteMs;
            });

            // --- PROTECCIÓN ANTIBORRADO MASIVO ---
            // Si el resultado es que solo queda el encabezado pero el original tenía muchos datos,
            // detenemos el proceso porque es probable que el formato de fecha de Google Sheets haya cambiado.
            if (filasConservadas.length === 1 && rows.length > 5) {
                console.error(`[!] ABORTADO: Se detectó un intento de borrado total en ${envKey}. Verifique el formato de fecha.`);
                continue;
            }

            if (rows.length !== filasConservadas.length) {
                console.log(`[BACKUP] Realizando respaldo de seguridad de ${envKey}...`);
                await backupFile(spreadsheetId, 'BACKUPS_ARCHIVOS_DRIVE');

                console.log(`[ACTION] Eliminando ${rows.length - filasConservadas.length} filas con más de 21 días.`);
                
                // 1. Limpiar hoja
                await sheets.spreadsheets.values.clear({ spreadsheetId, range: sheetName });

                // 2. Insertar sobrevivientes por bloques
                const CHUNK_SIZE = 5000;
                for (let i = 0; i < filasConservadas.length; i += CHUNK_SIZE) {
                    const chunk = filasConservadas.slice(i, i + CHUNK_SIZE);
                    await sheets.spreadsheets.values.update({
                        spreadsheetId,
                        range: `${sheetName}!A${i + 1}`,
                        valueInputOption: "USER_ENTERED",
                        requestBody: { values: chunk }
                    });
                }
                console.log(`[SUCCESS] ${envKey} actualizado correctamente.`);
            } else {
                console.log(`[INFO] No hay registros mayores a 21 días en ${envKey}.`);
            }

        } catch (error) {
            console.error(`[ERROR] Fallo en ${envKey}: ${error.message}`);
        }
    }
};