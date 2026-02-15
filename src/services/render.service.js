import { execFile } from "child_process";
import path from "path";

export const renderPdfToImages = async (pdfPath, outputDir) => {
    return new Promise((resolve, reject) => {
        const popplerBin = process.env.POPPLER_BIN;
        // evitar errores por espacios en carpetas
        const args = [
            "-png", 
            "-r", "150", //ajustar resolución de imagen
            pdfPath.replace(/"/g, ''), 
            path.join(outputDir, "page").replace(/"/g, '')
        ];

        execFile(popplerBin, args, { shell: true }, (err, stdout, stderr) => {
            if (err) return reject(new Error(`Poppler error: ${stderr || err.message}`));
            resolve(stdout);
        });
    });
};