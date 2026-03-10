import { execFile } from "child_process";
import path from "path";
import { PATHS } from "../config/tenants.js";

/**
 * Renderiza el PDF a imágenes usando Poppler (pdftoppm).
 * @param {string} pdfPath - Ruta del archivo PDF local.
 * @param {string} outputDir - Carpeta de destino de las imágenes.
 * @param {boolean} onlyFirstPage - Si es true, solo procesa la carátula (monitor).
 */
export const renderPdfToImages = async (pdfPath, outputDir, onlyFirstPage = false) => {
    return new Promise((resolve, reject) => {
        const popplerBin = PATHS.binaries.poppler;

        if (!popplerBin) {
            const errorMsg = "CONFIG_ERROR: Binario de Poppler no definido en PATHS.binaries.poppler";
            console.error(`CRITICAL: ${errorMsg}`);
            return reject(new Error(errorMsg));
        }

        // Argumentos base: 150 DPI es el balance ideal entre velocidad y lectura de QR
        const args = ["-png", "-r", "150"];

        if (onlyFirstPage) {
            args.push("-f", "1", "-l", "1");
        }

        // Sanitización de rutas para evitar problemas con espacios o caracteres especiales
        const cleanPdfPath = path.normalize(pdfPath);
        const cleanOutputPath = path.join(outputDir, "page");

        args.push(cleanPdfPath, cleanOutputPath);

        // INFO log simplificado: Ayuda a debugear si el binario responde
        const mode = onlyFirstPage ? "PRIMERA_HOJA" : "FULL_PDF";
        console.log(`INFO: RENDER_START - Mode: ${mode} | File: ${path.basename(pdfPath)}`);

        // Usamos execFile sin { shell: true } para mayor seguridad y rendimiento
        execFile(popplerBin, args, (err, stdout, stderr) => {
            if (err) {
                // Captura de error con contexto de Poppler (stderr)
                const reason = stderr?.trim() || err.message;
                console.error(`ERROR: RENDER_FAILED - File: ${path.basename(pdfPath)} | Reason: ${reason}`);
                return reject(new Error(`POPPLER_ERROR: ${reason}`));
            }
            
            // Éxito silencioso: No ponemos log aquí para no saturar, el servicio superior ya tiene su log de éxito.
            resolve(stdout);
        });
    });
};