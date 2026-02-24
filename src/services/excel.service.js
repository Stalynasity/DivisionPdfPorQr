import { google } from "googleapis";
import { getOAuthClient } from "./auth.oauth.js";
import dotenv from "dotenv";

dotenv.config();

const SPREADSHEET_ID = process.env.EXCEL_DATABASE_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Caratulas_Maestro";

let sheetsInstance;

const getSheetsClient = async () => {
    if (!sheetsInstance) {
        const auth = await getOAuthClient();
        sheetsInstance = google.sheets({ version: "v4", auth });
    }
    return sheetsInstance;
};

/**
 * Busca un ID y retorna toda la fila como objeto
 */
export const getDataFromExcel = async (idBusqueda) => {
    try {
        const sheets = await getSheetsClient();
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A:Z`, 
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
 * Actualiza una celda específica (ej. Columna "Estado" o "Link")
 */
export const updateSheetRow = async (rowNumber, columnName, value) => {
    try {
        const sheets = await getSheetsClient();
        
        // 1. Obtener encabezados para saber qué letra de columna es
        const headerRes = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!1:1`,
        });
        
        const headers = headerRes.data.values[0];
        const colIndex = headers.indexOf(columnName);
        if (colIndex === -1) throw new Error(`Columna ${columnName} no encontrada`);

        // Convertir índice a letra (0=A, 1=B...)
        const colLetter = String.fromCharCode(65 + colIndex);

        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!${colLetter}${rowNumber}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[value]] }
        });

        console.log(`[SHEETS] Columna ${columnName} actualizada en fila ${rowNumber}`);
    } catch (error) {
        console.error(`[SHEETS UPDATE ERROR] ${error.message}`);
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