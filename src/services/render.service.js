import { execFile } from "child_process";
import path from "path";

export const renderPdfToImages = async (pdfPath, outputDir) => {
    return new Promise((resolve, reject) => {
        const popplerBin = process.env.POPPLER_BIN;
        const args = ["-png", pdfPath, path.join(outputDir, "page")];

        execFile(popplerBin, args, (err, stdout, stderr) => {
            if (err) return reject(err);
            resolve(stdout);
        });
    });
};
