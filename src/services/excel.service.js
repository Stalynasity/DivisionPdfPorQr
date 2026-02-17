import * as XLSX from "xlsx";
import { getDriveClient } from "./drive.service.js";
import dotenv from "dotenv";

dotenv.config();

export const getDataFromExcel = async (idBusqueda) => {
    try {
        const drive = await getDriveClient();
        const SPREADSHEET_ID = process.env.EXCEL_DATABASE_ID;

        // Descarga obligatoria en cada llamada
        const response = await drive.files.export(
            {
                fileId: SPREADSHEET_ID,
                mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            },
            { responseType: "arraybuffer" }
        );

        const workbook = XLSX.read(response.data, { type: "buffer" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet);

        const cleanSearchId = String(idBusqueda).trim().toLowerCase();

        // Buscamos el ID_Caratula y devolvemos TODA la fila (metadata)
        const registro = rows.find(row => {
            const rowId = row.ID_Caratula || row.id_caratula;
            return String(rowId).trim().toLowerCase() === cleanSearchId;
        });

        return registro || null;

    } catch (error) {
        console.error(`[EXCEL ERROR] Falló la descarga en tiempo real: ${error.message}`);
        throw error; // Re-lanzamos para que el Worker sepa que hubo un error de red
    }
};