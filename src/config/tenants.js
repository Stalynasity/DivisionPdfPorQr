import dotenv from "dotenv";
import path from "path";
dotenv.config();

export const TENANT_FOLDERS = {
    Automatico: "1ZaXQB0TGDL4Qcb8Miz_gS_mBvD1w5Fuy",
    //Manual: "1_p4CdzPWEaWz3NYywhbNTNNpwAgle-5q",
    PDF_COMPLETO_AUTOMATIZACION: "1_p4CdzPWEaWz3NYywhbNTNNpwAgle-5q"
};

export const SYSTEM_FOLDERS = {
    ENTRADA: "1P7AgsYFh6XL_FK8Ww1WLC1KjQ8Jq39oB",
    TRANSITO: "1f6DEUzg5-D-NraANU5WyYZzeuVCoW7Hc",
    PROCESADOS: "1yVSIgrK-V3hHR1pjTggjNoRaZ8E-SsLf",
    ERRORES: "14kfle_EpkJmsFOFS6MbirlaVihPPHrLx"
};

export const PATHS = {
    // Si el .env falla, usamos carpetas relativas al proyecto por defecto
    tempImg: process.env.TEMP_IMG_PATH || path.join("tmp", "img"),
    tempPdf: process.env.TEMP_PDF_PATH || path.join("tmp", "pdf"),
    binaries: {
        // Importante: poppler suele necesitar el ejecutable exacto pdftoppm
        poppler: process.env.POPPLER_PATH || "C:\\poppler\\Library\\bin\\pdftoppm.exe"
    }
};