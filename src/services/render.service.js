import { execFile } from "child_process";
import path from "path";
import { PATHS } from "../config/tenants.js";

/**
 * Renderiza el PDF a imágenes en alta fidelidad.
 */
export const renderPdfToImages = async (pdfPath, outputDir, onlyFirstPage = false) => {
    return new Promise((resolve, reject) => {
        const popplerBin = PATHS.binaries.poppler;

        if (!popplerBin) {
            return reject(new Error("CONFIG_ERROR: Binario de Poppler no definido"));
        }
        const args = ["-png", "-r", "100"];

        if (onlyFirstPage) {
            args.push("-f", "1", "-l", "1");
        }

        const cleanPdfPath = path.normalize(pdfPath);
        // Al usar -singlefile, el nombre será exactamente "page.png"
        const outputPrefix = onlyFirstPage ? "page" : "pg";
        const cleanOutputPath = path.join(outputDir, outputPrefix);

        args.push(cleanPdfPath, cleanOutputPath);

        const mode = onlyFirstPage ? "PRIMERA_HOJA" : "FULL_PDF";
        console.log(` [RENDERER] Renderizando calidad original (${mode}): ${path.basename(pdfPath)}`);

        execFile(popplerBin, args, (err, stdout, stderr) => {
            if (err) {
                const reason = stderr?.trim() || err.message;
                console.error(` [RENDERER] Error: ${reason}`);
                return reject(new Error(`POPPLER_ERROR: ${reason}`));
            }
            resolve(stdout);
        });
    });
};