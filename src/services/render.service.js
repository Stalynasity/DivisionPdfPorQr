import { execFile } from "child_process";
import path from "path";
import { PATHS } from "../config/tenants.js";

/**
 * Renderiza el PDF a imágenes.
 * @param {string} pdfPath - Ruta del archivo PDF.
 * @param {string} outputDir - Carpeta de destino.
 * @param {boolean} onlyFirstPage - usa los flags de Poppler para solo pág 1.
 */
export const renderPdfToImages = async (pdfPath, outputDir, onlyFirstPage = false) => {
    return new Promise((resolve, reject) => {
        // Usamos la ruta del binario definida en tus PATHS
        const popplerBin = PATHS.binaries.poppler;

        if (!popplerBin) {
            return reject(new Error("La ruta de Poppler (pdftoppm) no está definida en PATHS.binaries.poppler"));
        }

        console.log(`[RENDER] Ejecutando Poppler desde: ${popplerBin}`);

        const args = [
            "-png",
            "-r", "150",
        ];

        // Optimización para el Monitor
        if (onlyFirstPage) {
            args.push("-f", "1", "-l", "1");
        }

        args.push(
            pdfPath.replace(/"/g, ''), 
            path.join(outputDir, "page").replace(/"/g, '')
        );

        execFile(popplerBin, args, { shell: true }, (err, stdout, stderr) => {
            if (err) {
                console.error(`[RENDER ERROR] Poppler falló: ${stderr || err.message}`);
                return reject(new Error(`Poppler error: ${stderr || err.message}`));
            }
            resolve(stdout);
        });
    });
};