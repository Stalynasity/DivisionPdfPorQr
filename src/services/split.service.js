import fs from "fs-extra";
import { PDFDocument } from "pdf-lib";
import { renderPdfToImages } from "./render.service.js";
import { readQR } from "./qr.service.js";
import { saveToDrive } from "./drive.service.js";
import { TENANT_FOLDERS, PATHS } from "../config/tenants.js";
import pLimit from "p-limit";
import path from "path";

export const processPdfSplit = async (pdfPath, tenant, jobId) => {
    const startTime = Date.now();
    const tmpDir = path.join(PATHS.tempImg, `job-${jobId}`); // Carpeta privada
    const folderId = TENANT_FOLDERS[tenant];

    console.log(`[INFO] [SYSTEM_START] Processing request for Tenant: [${tenant.toUpperCase()}]`);
    console.log(`[INFO] [FILE_PATH] Source: ${pdfPath}`);

    if (!folderId) {
        console.error(`[ERROR] [CONFIG_FAULT] Tenant '${tenant}' is not registered in TENANT_FOLDERS.`);
        throw new Error(`Tenant no registrado: ${tenant}`);
    }

    try {
        // STEP 0: Limpieza de directorios
        await fs.ensureDir(tmpDir); 
        await fs.emptyDir(tmpDir);
        console.log(`[INFO] [CLEANUP] Workspace initialized: ${tmpDir}`);

        // STEP 1: Renderizado de PDF
        const renderStart = Date.now();
        await renderPdfToImages(pdfPath, tmpDir);
        console.log(`[INFO] [RENDER] PDF-to-Image conversion completed in ${((Date.now() - renderStart) / 1000).toFixed(2)}s`);

        // STEP 2: Validación de archivos
        const files = (await fs.readdir(tmpDir)).sort();
        if (!files.length) throw new Error("No images were generated from the source PDF.");
        console.log(`[INFO] [ANALYSIS] Detected ${files.length} pages for processing.`);

        // STEP 3: Reconocimiento de QR
        console.log("[INFO] [QR_SCAN] Initializing barcode recognition...");
        const limit = pLimit(4);
        const firstPagePath = path.join(tmpDir, files[0]);

        let idCaratula = await readQR(firstPagePath);
        if (!idCaratula) throw new Error("Metadata failure: Main QR ID not found on cover page.");
        idCaratula = idCaratula.replace(/^"+|"+$/g, "").trim();
        console.log(`[INFO] [METADATA] Cover ID identified as: ${idCaratula}`);

        const qrResults = await Promise.all(
            files.slice(1).map(file => limit(async () => {
                const imgPath = path.join(tmpDir, file);
                const pageIdx = parseInt(file.match(/\d+/)[0]) - 1;
                let qrData = null;
                try {
                    qrData = await readQR(imgPath);
                    if (qrData) {
                        qrData = qrData.replace(/^"+|"+$/g, "").trim();
                        console.log(`[DEBUG] [QR_FOUND] Page ${pageIdx + 1}: ${qrData}`);
                    }
                } catch (err) {
                    console.warn(`[WARN] [QR_READ_FAIL] Page ${pageIdx + 1}: ${err.message}`);
                }
                return { file, qrData, pageIdx };
            }))
        );

        // STEP 4: Segmentación lógica
        console.log("[INFO] [SEGMENTATION] Organizing document blocks based on separators...");
        const bloques = [];
        let bloqueActual = [];
        let codigoActual = null;

        for (const { file, qrData, pageIdx } of qrResults) {
            if (qrData && qrData.startsWith("SEP|")) {
                const nuevoCodigo = qrData.split("|")[1]?.trim() || "UNKNOWN";
                if (bloqueActual.length) {
                    bloques.push({ files: [...bloqueActual], codigoCategoria: codigoActual || "UNKNOWN" });
                }
                bloqueActual = [{ file, pageIdx }];
                codigoActual = nuevoCodigo;
                continue;
            }
            bloqueActual.push({ file, pageIdx });
        }

        if (bloqueActual.length) {
            bloques.push({ files: bloqueActual, codigoCategoria: codigoActual || "UNKNOWN" });
        }
        console.log(`[INFO] [SEGMENTATION_COMPLETE] Total segments identified: ${bloques.length}`);

        // STEP 5: Generación de PDF y Carga masiva (Batch Copying)
        console.log("[INFO] [OUTPUT_GEN] Initializing concurrent upload and batch copying...");
        const pdfData = await fs.readFile(pdfPath);
        const originalPdf = await PDFDocument.load(pdfData, { ignoreEncryption: true });
        const uploadTasks = [];

        // 1. PDF Íntegro
        uploadTasks.push((async () => {
            const pdfCompleto = await PDFDocument.create();
            const indices = Array.from({ length: originalPdf.getPageCount() }, (_, i) => i);

            // TÉCNICA: Batch Copying - Copia de bajo nivel de objetos PDF en una sola operación
            const copiedPages = await pdfCompleto.copyPages(originalPdf, indices);
            copiedPages.forEach(p => pdfCompleto.addPage(p));

            const bytes = await pdfCompleto.save();
            const url = await saveToDrive(Buffer.from(bytes), `GEN_AUTOMATICO_${idCaratula}.pdf`, TENANT_FOLDERS.PDF_COMPLETO_AUTOMATIZACION);
            console.log(`[INFO] [UPLOAD] Main document stored for: `,TENANT_FOLDERS.Automatico);
            return url;
        })());

        // 2. Segmentos por separador
        bloques.forEach((bloque) => {
            uploadTasks.push((async () => {
                const nuevoPdf = await PDFDocument.create();
                const indices = bloque.files.map(f => f.pageIdx);

                // Aplicación de Batch Copying para segmentos
                const copiedPages = await nuevoPdf.copyPages(originalPdf, indices);
                copiedPages.forEach(p => nuevoPdf.addPage(p));

                const bytes = await nuevoPdf.save();
                const nombrePdf = `${bloque.codigoCategoria}_${idCaratula}.pdf`;
                const url = await saveToDrive(Buffer.from(bytes), nombrePdf, folderId);
                console.log(`[INFO] [UPLOAD] Segment block [${bloque.codigoCategoria}] stored successfully.`);
                return url;
            })());
        });

        const pdfsResult = await Promise.all(uploadTasks);

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[SUCCESS] [JOB_FINISHED] Execution time: ${duration}s | Total files: ${pdfsResult.length}`);

        return pdfsResult;

    } catch (err) {
        console.error(`[CRITICAL] [JOB_FAILED] Job ${jobId}: ${err.message}`);
        throw err;
    } finally {
        // LIMPIEZA ATÓMICA: Solo borramos lo que este Job creó
        await Promise.all([
            fs.remove(tmpDir).catch(() => {}), // Borra carpeta de imágenes del job
            fs.remove(pdfPath).catch(() => {}) // Borra el PDF original descargado
        ]);
        console.log(`[INFO] [CLEANUP] Resources for Job ${jobId} released.`);
    }
};