import { execFile } from "child_process";
import path from "path";
import { PATHS } from "../config/tenants.js";

const PREFIJO_SALIDA = { primera: "page", completo: "pg" };

/**
 * Renderiza un PDF a imágenes PNG usando Poppler (pdftoppm).
 *
 * @param {string}  rutaPdf      - Ruta absoluta al PDF
 * @param {string}  dirSalida    - Carpeta donde se guardan las imágenes
 * @param {boolean} soloPrimera  - Si true, renderiza solo la primera página
 */
export const renderizarPdfAImagenes = (rutaPdf, dirSalida, soloPrimera = false) => {
    return new Promise((resolve, reject) => {
        const binario = PATHS.binaries.poppler;
        if (!binario) return reject(new Error("CONFIG_ERROR: Binario de Poppler no definido"));

        const args = ["-png", "-r", "250"];
        if (soloPrimera) args.push("-f", "1", "-l", "1");

        const prefijo = soloPrimera ? PREFIJO_SALIDA.primera : PREFIJO_SALIDA.completo;
        args.push(path.normalize(rutaPdf), path.join(dirSalida, prefijo));

        execFile(binario, args, (err, _stdout, stderr) => {
            if (err) return reject(new Error(`POPPLER_ERROR: ${stderr?.trim() || err.message}`));
            resolve();
        });
    });
};