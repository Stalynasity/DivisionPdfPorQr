import { google } from "googleapis";
import { getOAuthClient } from "./auth.oauth.js";
import dotenv from "dotenv";

dotenv.config();

const SPREADSHEET_ID = process.env.EXCEL_DIGITALIZACION;
const SPREADSHEET_ID_MONITOREO = process.env.EXCEL_MONITOREO_ID;
const SHEET_NAME = process.env.SHEET_NAME_MAESTRO;

let sheetsInstance;

const getSheetsClient = async () => {
    if (!sheetsInstance) {
        const auth = await getOAuthClient();
        sheetsInstance = google.sheets({ version: "v4", auth });
    }
    return sheetsInstance;
};
export const asignacionDriveUser = async () => {
    try {
        const sheets = await getSheetsClient();
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A:A`,
        });
        const rows = response.data.values;
        if (!rows || rows.length === 0) return null;
    }
    catch (error) {
        console.error(`[SHEETS ERROR] ${error.message}`);
        throw error;
    }
};


/**
 * Inserta filas con lógica de reintento (Exponential Backoff)
 */
export const insertDocumentRowsBatch = async (rowsArray, App_asignada, retries = 3, delay = 2000) => {
    const batchSize = rowsArray?.length || 0;

    for (let i = 0; i < retries; i++) {
        try {
            if (batchSize === 0) {
                console.log(`[SHEETS] Omitiendo batch: No hay filas para insertar.`);
                return;
            }

            console.log(`[SHEETS]  Intentando insertar batch de ${batchSize} filas en [${App_asignada}]... (Intento ${i + 1}/${retries})`);

            const sheets = await getSheetsClient();
            let spreadsheetId = "";

            // Selección dinámica del Spreadsheet según la App asignada
            switch (App_asignada) {
                case "APP-1": spreadsheetId = process.env.APP1_EXCEL_ARCHIVOS_DRIVE_ID; break;
                case "APP-2": spreadsheetId = process.env.APP2_EXCEL_ARCHIVOS_DRIVE_ID; break;
                case "APP-3": spreadsheetId = process.env.APP3_EXCEL_ARCHIVOS_DRIVE_ID; break;
                case "APP-4": spreadsheetId = process.env.APP4_EXCEL_ARCHIVOS_DRIVE_ID; break;
                case "APP-5": spreadsheetId = process.env.APP5_EXCEL_ARCHIVOS_DRIVE_ID; break;
                case "APP-6": spreadsheetId = process.env.APP6_EXCEL_ARCHIVOS_DRIVE_ID; break;
                default:
                    // CORRECCIÓN: Usamos App_asignada que es la variable real
                    throw new Error(`La aplicación "${App_asignada}" no está configurada en el sistema.`);
            }

            if (!spreadsheetId) {
                throw new Error(`El ID de Spreadsheet para ${App_asignada} está vacío en el archivo .env`);
            }

            const sheetName = process.env.SHEET_NAME_DRIVE || "Archivos_Drive";

            const response = await sheets.spreadsheets.values.append({
                spreadsheetId,
                range: `${sheetName}!A:G`,
                valueInputOption: "USER_ENTERED",
                requestBody: { values: rowsArray }
            });

            const updatedCells = response.data.updates?.updatedCells || 0;
            console.log(`[SHEETS] ✅ Batch exitoso: ${updatedCells} celdas actualizadas en [${App_asignada}] > ${sheetName}.`);
            return;

        } catch (error) {
            const isRateLimit = error.code === 429 || error.message.toLowerCase().includes('quota');

            if (isRateLimit && i < retries - 1) {
                console.warn(`[SHEETS ⚠️] Límite de cuota en ${App_asignada}. Reintentando en ${delay / 1000}s...`);
                await new Promise(res => setTimeout(res, delay));
                delay *= 2;
            } else {
                console.error(`[SHEETS ❌] ERROR CRÍTICO en [${App_asignada}]: ${error.message}`);
                if (error.errors) console.error(`           Detalles API: ${JSON.stringify(error.errors)}`);
                throw error; // Re-lanzamos para que el servicio de arriba lo capture
            }
        }
    }
};



/**
 * Busca un ID y retorna toda la fila como objeto
 */
export const getDataFromExcel = async (idBusqueda) => {
    try {
        const sheets = await getSheetsClient();
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A:AZ`,
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) return null;

        const headers = rows[0];
        const cleanSearchId = String(idBusqueda).trim().toLowerCase();

        // Buscamos el índice de la columna ID_Caratula dinámicamente
        const idColIndex = headers.indexOf("ID_Caratula");

        const rowIndex = rows.findIndex((row, idx) =>
            idx > 0 && String(row[idColIndex] ?? "").trim().toLowerCase() === cleanSearchId
        );

        if (rowIndex === -1) return null;

        const rowData = rows[rowIndex];

        // Retornamos objeto con data y el número de fila (útil para actualizar luego)
        const result = headers.reduce((acc, header, index) => {
            acc[header] = rowData[index] || "";
            return acc;
        }, {});

        return { ...result, rowNumber: rowIndex + 1 };

    } catch (error) {
        console.error(`[SHEETS ERROR] ${error.message}`);
        throw error;
    }
};

/**
 * Actualiza una celda específica con manejo de errores y logs descriptivos
 */
export const updateSheetRow = async (rowNumber, Tabla, columnName, value) => {
    let SPREADSHEET_ID_CASE = "";
    let SHEET_NAME = process.env.SHEET_NAME_MAESTRO;

    try {
        // Determinamos qué Google Sheet usar
        switch (Tabla) {
            case "monitoreo":
                SPREADSHEET_ID_CASE = SPREADSHEET_ID_MONITOREO;
                SHEET_NAME = process.env.SHEET_NAME_MONITOREO;
                break;
            case "maestro":
                SPREADSHEET_ID_CASE = SPREADSHEET_ID;
                break;
            default:
                throw new Error(`Tabla "${Tabla}" no reconocida en el sistema`);
        }

        console.log(`[SHEETS] Intentando actualizar: [Tabla: ${Tabla}] [Fila: ${rowNumber}] [Columna: ${columnName}]`);

        const sheets = await getSheetsClient();

        // 2. Obtener encabezados para mapear letra de columna
        const headerRes = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID_CASE,
            range: `${SHEET_NAME}!1:1`,
        });

        if (!headerRes.data.values || headerRes.data.values.length === 0) {
            throw new Error(`No se pudieron obtener los encabezados de la hoja ${SHEET_NAME}`);
        }

        const headers = headerRes.data.values[0];
        const colIndex = headers.indexOf(columnName);

        if (colIndex === -1) {
            throw new Error(`La columna "${columnName}" no existe en la hoja ${SHEET_NAME}`);
        }

        // Convertir índice a letra (Nota: esto solo funciona hasta la columna Z)
        // Para sistemas grandes es mejor una función helper 'indexToLetter'
        const colLetter = String.fromCharCode(65 + colIndex);
        const rangeTarget = `${SHEET_NAME}!${colLetter}${rowNumber}`;

        // 3. Ejecutar actualización
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID_CASE,
            range: rangeTarget,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[value]] }
        });

        console.log(`[SHEETS] ✅ ÉXITO: Celda ${rangeTarget} actualizada con el valor: "${value}"`);

    } catch (error) {
        // Log detallado del fallo para el debug
        console.error(`[SHEETS UPDATE ERROR] Falló actualización en ${Tabla}: ${error.message}`);
        // Lanzamos el error para que el Worker sepa que algo falló, 
        // a menos que prefieras que el proceso siga a pesar del log de Excel.
        throw error;
    }
};


export const existsIdCaratula = async (idBusqueda) => {
    try {
        const sheets = await getSheetsClient();
        const cleanSearchId = String(idBusqueda).trim().toLowerCase();

        // Pedimos solo la columna A para ahorrar ancho de banda y tiempo
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A:A`,
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) return null;

        // Buscamos el índice. rowIndex + 1 nos da la fila real de Sheets
        const rowIndex = rows.findIndex((row) =>
            String(row[0] ?? "").trim().toLowerCase() === cleanSearchId
        );

        return rowIndex !== -1 ? rowIndex + 1 : null;

    } catch (error) {
        console.error(`[SHEETS QUICK CHECK ERROR] ${error.message}`);
        return null;
    }
};