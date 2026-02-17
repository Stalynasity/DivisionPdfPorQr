import * as XLSX from "xlsx";
import { getDriveClient } from "./drive.service.js";
import dotenv from "dotenv";

dotenv.config();

export const getDataFromExcel = async (idBusqueda) => {
    try {
        const drive = await getDriveClient();
        const SPREADSHEET_ID = process.env.EXCEL_DATABASE_ID; 

        // LOG DE DEPURACIÓN
        console.log(`[EXCEL] Intentando acceder al Excel con ID: ${SPREADSHEET_ID}`);

        if (!SPREADSHEET_ID) {
            throw new Error("La variable EXCEL_DATABASE_ID no está definida en el .env");
        }

        const response = await drive.files.export(
            {
                fileId: SPREADSHEET_ID,
                mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            },
            { responseType: "arraybuffer" }
        );

        console.log(`[EXCEL] Archivo descargado de Drive, procesando hojas...`);

        const workbook = XLSX.read(response.data, { type: "buffer" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet);

        const cleanSearchId = String(idBusqueda).trim().toLowerCase();

        // Buscamos específicamente en la columna ID_Caratula que se ve en tu imagen
        const registro = rows.find(row => {
            const rowId = row.ID_Caratula || row.id_caratula || row.ID; 
            return String(rowId).trim().toLowerCase() === cleanSearchId;
        });

        if (!registro) {
            console.warn(`[EXCEL] ID [${idBusqueda}] no encontrado en las filas.`);
            return null;
        }

        return registro;
    } catch (error) {
        console.error("Error leyendo base de datos Excel:", error.message);
        throw error;
    }
};