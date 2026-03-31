import { google } from "googleapis";
import { getOAuthClient } from "./auth.oauth.js";
import dotenv from "dotenv";
import Redis from "ioredis";
import { connection } from "../config/redis.js";

dotenv.config();

// ============================================================================
// 1. CONFIGURACIÓN Y CLIENTES (Single Responsibility)
// ============================================================================

const redisClient = new Redis(connection);
const BATCH_KEY_PREFIX = "excel_buffer:";
const STATUS_KEY_PREFIX = "excel_status_buffer";

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
    if (!dateString) return null;
    try {
        const [datePart, timePart = "00:00:00"] = dateString.split(' ');
        const [day, month, year] = datePart.split('/');
        const [hour, minute, second] = timePart.split(':');
        return new Date(year, month - 1, day, hour, minute, second);
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
        if (!rows || rows.length <= 1) {
            console.log("[CLEANUP] No hay datos suficientes para limpiar.");
            return;
        }

        const headers = rows[0];
        const fechaIdx = headers.indexOf("Fecha_creacion"); 
        
        if (fechaIdx === -1) {
            console.error("[CLEANUP] CRÍTICO: Columna 'Fecha_creacion' no encontrada.");
            return;
        }

        const hoy = new Date();
        const limiteMs = 21 * 24 * 60 * 60 * 1000; // 21 días

        const filasConservadas = rows.filter((row, idx) => {
            if (idx === 0) return true; 
            
            const valorFechaStr = row[fechaIdx];
            if (!valorFechaStr) return true; 

            const fechaFila = parseCustomDate(valorFechaStr);
            if (!fechaFila || isNaN(fechaFila.getTime())) return true; 

            return (hoy - fechaFila) < limiteMs;
        });

        const filasBorradas = rows.length - filasConservadas.length;

        if (filasBorradas > 0) {
            console.log(`[CLEANUP] Borrando ${filasBorradas} filas con más de 21 días...`);
            await sheets.spreadsheets.values.clear({
                spreadsheetId: SPREADSHEET_ID,
                range: SHEET_NAME_MAESTRO,
            });
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: SHEET_NAME_MAESTRO,
                valueInputOption: "USER_ENTERED",
                requestBody: { values: filasConservadas }
            });
            console.log(`[CLEANUP] Listo. Quedan ${filasConservadas.length} filas.`);
        } else {
            console.log("[CLEANUP] Ninguna fila superó los 21 días.");
        }
    } catch (error) {
        console.error(`ERROR: CLEANUP_FAILED - ${error.message}`);
    }
};