import { google } from "googleapis";
import { getOAuthClient } from "./auth.oauth.js";
import dotenv from "dotenv";

dotenv.config();

const SPREADSHEET_ID = process.env.EXCEL_DIGITALIZACION;
const SPREADSHEET_ID_MONITOREO = process.env.EXCEL_MONITOREO_ID;
const SHEET_NAME_MAESTRO = process.env.SHEET_NAME_MAESTRO;

let sheetsInstance;

const getSheetsClient = async () => {
    if (!sheetsInstance) {
        const auth = await getOAuthClient();
        sheetsInstance = google.sheets({ version: "v4", auth });
        console.log("INFO: SHEETS_READY - Cliente de Google Sheets inicializado");
    }
    return sheetsInstance;
};

/**
 * Inserta filas con lógica de Exponential Backoff (Resiliencia SRE)
 */
export const insertDocumentRowsBatch = async (rowsArray, App_asignada, retries = 3, delay = 2000) => {
    const batchSize = rowsArray?.length || 0;
    if (batchSize === 0) return;

    for (let i = 0; i < retries; i++) {
        try {
            const sheets = await getSheetsClient();
            
            // Mapeo dinámico de IDs (O - Open/Closed Principle)
            const apps = {
                "APP-1": process.env.APP1_EXCEL_ARCHIVOS_DRIVE_ID,
                "APP-2": process.env.APP2_EXCEL_ARCHIVOS_DRIVE_ID,
                "APP-3": process.env.APP3_EXCEL_ARCHIVOS_DRIVE_ID,
                "APP-4": process.env.APP4_EXCEL_ARCHIVOS_DRIVE_ID,
                "APP-5": process.env.APP5_EXCEL_ARCHIVOS_DRIVE_ID,
                "APP-6": process.env.APP6_EXCEL_ARCHIVOS_DRIVE_ID,
            };

            const spreadsheetId = apps[App_asignada];
            if (!spreadsheetId) throw new Error(`APP_NOT_CONFIGURED: ${App_asignada}`);

            const sheetName = process.env.SHEET_NAME_DRIVE || "Archivos_Drive";

            const response = await sheets.spreadsheets.values.append({
                spreadsheetId,
                range: `${sheetName}!A:G`,
                valueInputOption: "USER_ENTERED",
                requestBody: { values: rowsArray }
            });

            return;

        } catch (error) {
            const isRateLimit = error.code === 429 || error.message.includes('quota');
            if (isRateLimit && i < retries - 1) {
                console.warn(`WARN: SHEETS_QUOTA_HIT - Reintentando en ${delay/1000}s (Intento ${i+1})`);
                await new Promise(res => setTimeout(res, delay));
                delay *= 2;
            } else {
                console.error(`ERROR: SHEETS_APPEND_FAILED - App: ${App_asignada} | Msg: ${error.message}`);
                throw error;
            }
        }
    }
};

/**
 * Recupera datos de una fila específica (Single Responsibility)
 */
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

        const result = headers.reduce((acc, header, index) => {
            acc[header] = rows[rowIndex][index] || "";
            return acc;
        }, { rowNumber: rowIndex + 1 });

        return result;
    } catch (error) {
        console.error(`ERROR: SHEETS_FETCH_FAILED - ID: ${idBusqueda} | Msg: ${error.message}`);
        throw error;
    }
};

/**
 * Actualiza una celda con mapeo automático de columnas
 */
export const updateSheetRow = async (rowNumber, Tabla, columnName, value) => {
    try {
        const config = {
            monitoreo: { id: SPREADSHEET_ID_MONITOREO, sheet: process.env.SHEET_NAME_MONITOREO },
            maestro: { id: SPREADSHEET_ID, sheet: SHEET_NAME_MAESTRO }
        };

        const target = config[Tabla];
        if (!target) throw new Error(`INVALID_TABLE: ${Tabla}`);

        const sheets = await getSheetsClient();
        
        // Obtener encabezados para hallar la columna
        const headerRes = await sheets.spreadsheets.values.get({
            spreadsheetId: target.id,
            range: `${target.sheet}!1:1`,
        });

        const headers = headerRes.data.values?.[0] || [];
        const colIndex = headers.indexOf(columnName);
        if (colIndex === -1) throw new Error(`COLUMN_NOT_FOUND: ${columnName}`);

        const colLetter = String.fromCharCode(65 + colIndex);
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

/**
 * Verificación rápida de existencia
 */
export const existsIdCaratula = async (idBusqueda) => {
    try {
        const sheets = await getSheetsClient();
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME_MAESTRO}!A:A`,
        });

        const rows = response.data.values || [];
        const cleanId = String(idBusqueda).trim().toLowerCase();

        const rowIndex = rows.findIndex(row => String(row[0] ?? "").trim().toLowerCase() === cleanId);
        return rowIndex !== -1 ? rowIndex + 1 : null;

    } catch (error) {
        console.error(`ERROR: SHEETS_CHECK_FAILED - Msg: ${error.message}`);
        return null;
    }
};