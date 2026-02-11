import fs from "fs-extra";
import { PDFDocument } from "pdf-lib";
import { renderPdfToImages } from "./render.service.js";
import { readQR } from "./qr.service.js";
import { saveToDrive } from "./drive.service.js";
import { TENANT_FOLDERS } from "../config/tenants.js";
import pLimit from "p-limit";
import path from "path";

export const processPdfSplit = async (pdfPath, tenant) => {
    const tmpDir = path.join("tmp", "img");
    const folderId = TENANT_FOLDERS[tenant];
    if (!folderId) throw new Error(`Tenant no registrado: ${tenant}`);

    console.log("\n===============================");
    console.log("JOB START");
    console.log("TENANT:", tenant);
    console.log("PDF PATH:", pdfPath);
    console.log("===============================\n");

    try {
        // STEP 0: limpiar tmp
        console.log("[STEP 0] Limpiando tmp...");
        await fs.emptyDir(tmpDir);
        console.log("[OK] Tmp limpio");

        // STEP 1: render PDF → imágenes
        console.log("[STEP 1] Renderizando PDF a imágenes...");
        await renderPdfToImages(pdfPath, tmpDir);

        // STEP 2: leer archivos
        const files = (await fs.readdir(tmpDir)).sort();
        console.log(`[STEP 2] Archivos generados: ${files.join(", ")}`);
        if (!files.length) throw new Error("No se generaron imágenes desde el PDF");

        // STEP 3: leer QR
        console.log("[STEP 3] Leyendo QR del resto de páginas...");
        const limit = pLimit(4);

        // Leer carátula (primera página)
        const firstPagePath = path.join(tmpDir, files[0]);
        const idCaratula = await readQR(firstPagePath);
        if (!idCaratula) throw new Error("No se detectó QR en la carátula");
        console.log(`[OK] Carátula QR detectada: ${idCaratula}`);

        // Leer QR del resto de páginas
        const restFiles = files.slice(1);

        const qrResults = await Promise.all(
            restFiles.map(file =>
                limit(async () => {
                    const imgPath = path.join(tmpDir, file);
                    let qrData = null;
                    try {
                        qrData = await readQR(imgPath);
                        if (qrData) {
                            // quitar comillas dobles al inicio y final si existen
                            qrData = qrData.replace(/^"+|"+$/g, "").trim();
                            console.log(`   [QR DETECTADO] ${file}: "${qrData}"`);
                        } else {
                            console.log(`   [NO QR] ${file}`);
                        }
                    } catch (err) {
                        console.error(`   [ERROR QR] ${file}:`, err);
                    }
                    return { file, qrData };
                })
            )
        );

        // STEP 4: armar bloques por separador
        console.log("[STEP 4] Armando bloques por separador...");
        const bloques = [];
        let bloqueActual = [];
        let codigoActual = null;

        for (const { file, qrData } of qrResults) {
            if (qrData && qrData.startsWith("SEP|")) {
                const nuevoCodigo = qrData.split("|")[1]?.trim() || "UNKNOWN";

                // cerrar bloque actual si tiene páginas
                if (bloqueActual.length) {
                    bloques.push({ files: [...bloqueActual], codigoCategoria: codigoActual || "UNKNOWN" });
                    console.log(`[INFO] Bloque cerrado con ${bloqueActual.length} páginas, código: ${codigoActual || "UNKNOWN"}`);
                }

                // iniciar nuevo bloque con la página del separador
                bloqueActual = [file];
                codigoActual = nuevoCodigo;
                continue;
            }

            // páginas normales
            bloqueActual.push(file);
        }

        // último bloque
        if (bloqueActual.length) {
            bloques.push({ files: bloqueActual, codigoCategoria: codigoActual || "UNKNOWN" });
            console.log(`[INFO] Último bloque cerrado con ${bloqueActual.length} páginas, código: ${codigoActual || "UNKNOWN"}`);
        }

        console.log(`[OK] Total bloques detectados: ${bloques.length}`);

        // STEP 5: generar PDFs
        console.log("[STEP 5] Generando PDFs...");
        const originalPdf = await PDFDocument.load(fs.readFileSync(pdfPath));
        const pdfsResult = [];
        let pdfIndex = 1;

        // 1️⃣ PDF completo con carátula
        const pdfCompleto = await PDFDocument.create();
        for (const file of files) {
            const pageIndex = parseInt(file.replace("page-", "").replace(".png", "")) - 1;
            const [copiedPage] = await pdfCompleto.copyPages(originalPdf, [pageIndex]);
            pdfCompleto.addPage(copiedPage);
        }
        const bytesCompleto = await pdfCompleto.save();
        const nombrePdfCompleto = `GEN_AUTOMATICO_${idCaratula}.pdf`;
        const folderClienteB = TENANT_FOLDERS.clienteB; 

        const pdfUrlCompleto = await saveToDrive(
            Buffer.from(bytesCompleto), 
            nombrePdfCompleto, 
            folderClienteB // <--- Se guarda
        );

        pdfsResult.push(pdfUrlCompleto);
        console.log(`[OK] PDF completo subido a ClienteB: ${nombrePdfCompleto}`);

        // 2️⃣ PDFs por separador
        for (const bloque of bloques) {
            // ignorar bloque sin código (solo pasa si no hay SEP)
            if (!bloque.codigoCategoria) continue;

            const nuevoPdf = await PDFDocument.create();
            for (const file of bloque.files) {
                const pageIndex = parseInt(file.replace("page-", "").replace(".png", "")) - 1;
                const [copiedPage] = await nuevoPdf.copyPages(originalPdf, [pageIndex]);
                nuevoPdf.addPage(copiedPage);
            }

            const bytes = await nuevoPdf.save();
            const nombrePdf = `${bloque.codigoCategoria}_${idCaratula}.pdf`;

            console.log(`[DRIVE UPLOAD] name: ${nombrePdf}, folderId: ${folderId}, size: ${bytes.length}`);
            const pdfUrl = await saveToDrive(Buffer.from(bytes), nombrePdf, folderId);
            pdfsResult.push(pdfUrl);
            console.log(`[OK] PDF ${pdfIndex} subido: ${nombrePdf}`);
            pdfIndex++;
        }

        // STEP 6: limpieza tmp
        console.log("[STEP 6] Limpiando archivos temporales...");
        try {
            await fs.emptyDir(path.join("tmp", "pdf"));
            await fs.emptyDir(tmpDir);
            console.log("[OK] Tmp limpio");
        } catch (err) {
            console.warn("[WARNING] Error limpiando tmp:", err);
        }

        console.log("[JOB END]");
        return pdfsResult;

    } catch (err) {
        console.error("[JOB FAILED]", err);
        throw err;
    }
};
