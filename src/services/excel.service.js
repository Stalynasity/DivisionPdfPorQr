import ExcelJS from "exceljs";
import { getDriveClient } from "./drive.service.js";
import dotenv from "dotenv";

dotenv.config();

let cachedMap = null;
let lastModifiedTime = null;

export const getDataFromExcel = async (idBusqueda) => {
    try {
        const drive = await getDriveClient();
        const SPREADSHEET_ID = process.env.EXCEL_DATABASE_ID;

        // 🔥 Obtener metadata del archivo
        const metadata = await drive.files.get({
            fileId: SPREADSHEET_ID,
            fields: "modifiedTime"
        });

        const currentModifiedTime = metadata.data.modifiedTime;

        // 🔥 Solo descargar si cambió
        if (!cachedMap || lastModifiedTime !== currentModifiedTime) {

            console.log("[EXCEL] Archivo actualizado, descargando...");

            const response = await drive.files.export(
                {
                    fileId: SPREADSHEET_ID,
                    mimeType:
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                },
                { responseType: "arraybuffer" }
            );

            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(response.data);

            const worksheet = workbook.worksheets[0];

            const headers = [];
            const tempMap = new Map();

            worksheet.eachRow((row, rowNumber) => {

                if (rowNumber === 1) {
                    row.eachCell((cell, colNumber) => {
                        headers[colNumber] = cell.value;
                    });
                } else {
                    const rowData = {};

                    row.eachCell((cell, colNumber) => {
                        const header = headers[colNumber];
                        if (header) {
                            rowData[header] = cell.value;
                        }
                    });

                    const key = String(rowData.ID_Caratula ?? "")
                        .trim()
                        .toLowerCase();

                    if (key) {
                        tempMap.set(key, rowData);
                    }
                }
            });

            cachedMap = tempMap;
            lastModifiedTime = currentModifiedTime;

            console.log("[EXCEL] Cache actualizado por cambio real");
        }

        const cleanSearchId = String(idBusqueda).trim().toLowerCase();

        return cachedMap.get(cleanSearchId) || null;

    } catch (error) {
        console.error(`[EXCEL ERROR] ${error.message}`);
        throw error;
    }
};
