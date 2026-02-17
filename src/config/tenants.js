import dotenv from "dotenv";
import path from "path";
dotenv.config();

export const TENANT_FOLDERS = {
    Automatico: process.env.FOLDER_AUTOMATICO,
    PDF_COMPLETO_AUTOMATIZACION: process.env.FOLDER_PDF_COMPLETO
};

export const SYSTEM_FOLDERS = {
    ENTRADA: process.env.FOLDER_ENTRADA,
    TRANSITO: process.env.FOLDER_ENCOLADO,
    PROCESADOS: process.env.FOLDER_PROCESADOS,
    ERRORES: process.env.FOLDER_ERRORES
};

export const PATHS = {
    // Si el .env falla, usamos carpetas relativas al proyecto por defecto
    tempImg: process.env.TEMP_IMG_PATH || path.join("tmp", "img"),
    tempPdf: process.env.TEMP_PDF_PATH || path.join("tmp", "pdf"),
    binaries: {
        // poppler suele necesitar el ejecutable exacto pdftoppm
        poppler: process.env.POPPLER_BIN || "C:\\poppler\\Library\\bin\\pdftoppm.exe"
    }
};