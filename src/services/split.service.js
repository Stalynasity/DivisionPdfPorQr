import fs from "fs-extra";
import { PDFDocument } from "pdf-lib";
import { renderPdfToImages } from "./render.service.js";
import { readQR } from "./qr.service.js";
import { saveToDrive } from "./drive.service.js";
import { TENANT_FOLDERS, PATHS } from "../config/tenants.js";
import pLimit from "p-limit";
import path from "path";

/**
 * Procesa la división del PDF usando metadata ya validada por el monitor.
 * @param {string} pdfPath - Ruta local del PDF descargado.
 * @param {string} tenant - Nombre del tenant.
 * @param {string} jobId - ID del Job de BullMQ.
 * @param {Object} validatedData - Objeto que contiene { idCaratula, excelMetadata }.
 */
export const processPdfSplit = async (pdfPath, tenant, jobId, validatedData) => {
    const { idCaratula, excelMetadata } = validatedData;
    const startTime = Date.now();
    const tmpDir = path.join(PATHS.tempImg, `job-${jobId}`); 
    const folderId = TENANT_FOLDERS[tenant];

    console.log(`[INFO] [SYSTEM_START] Processing Job: ${jobId} | Tenant: [${tenant.toUpperCase()}]`);
    console.log(`[INFO] [METADATA] ID Carátula: ${idCaratula} | Cliente: ${excelMetadata.Cliente || 'N/A'}`);

    if (!folderId) {
        console.error(`[ERROR] [CONFIG_FAULT] Tenant '${tenant}' no registrado.`);
        throw new Error(`Tenant no registrado: ${tenant}`);
    }

    try {
        // STEP 0: Limpieza y preparación
        await fs.ensureDir(tmpDir); 
        await fs.emptyDir(tmpDir);

        // STEP 1: Renderizado de PDF (Todas las páginas para buscar separadores SEP|)
        const renderStart = Date.now();
        await renderPdfToImages(pdfPath, tmpDir); // Aquí renderizamos todo el documento
        console.log(`[INFO] [RENDER] PDF-to-Image completado en ${((Date.now() - renderStart) / 1000).toFixed(2)}s`);

        // STEP 2: Validación de imágenes generadas
        const files = (await fs.readdir(tmpDir))
            .filter(f => f.endsWith('.png'))
            .sort((a, b) => {
                const numA = parseInt(a.match(/\d+/)[0]);
                const numB = parseInt(b.match(/\d+/)[0]);
                return numA - numB;
            });

        if (!files.length) throw new Error("No se generaron imágenes del PDF original.");

        // STEP 3: Reconocimiento de QRs (Saltamos la primera página porque ya tenemos el idCaratula)
        console.log("[INFO] [QR_SCAN] Buscando separadores en páginas internas...");
        const limit = pLimit(4);
        
        // files.slice(1) omite la carátula
        const qrResults = await Promise.all(
            files.slice(1).map(file => limit(async () => {
                const imgPath = path.join(tmpDir, file);
                const pageIdx = parseInt(file.match(/\d+/)[0]) - 1;
                let qrData = null;
                try {
                    qrData = await readQR(imgPath);
                    if (qrData) {
                        qrData = qrData.replace(/^"+|"+$/g, "").trim();
                    }
                } catch (err) {
                    console.warn(`[WARN] [QR_READ_FAIL] Página ${pageIdx + 1}: ${err.message}`);
                }
                return { file, qrData, pageIdx };
            }))
        );

        // STEP 4: Segmentación lógica por separadores "SEP|..."
        const bloques = [];
        let bloqueActual = [];
        let codigoActual = null;

        for (const { qrData, pageIdx } of qrResults) {
            if (qrData && qrData.startsWith("SEP|")) {
                const nuevoCodigo = qrData.split("|")[1]?.trim() || "DESCONOCIDO";
                
                // Si ya teníamos un bloque acumulado, lo cerramos
                if (bloqueActual.length) {
                    bloques.push({ files: [...bloqueActual], codigoCategoria: codigoActual || "INICIO" });
                }
                
                // Iniciamos nuevo bloque con la página del separador
                bloqueActual = [{ pageIdx }];
                codigoActual = nuevoCodigo;
                continue;
            }
            bloqueActual.push({ pageIdx });
        }

        // Añadir el último bloque
        if (bloqueActual.length) {
            bloques.push({ files: bloqueActual, codigoCategoria: codigoActual || "FINAL" });
        }

        // STEP 5: Generación de PDFs y Carga a Drive
        const pdfData = await fs.readFile(pdfPath);
        const originalPdf = await PDFDocument.load(pdfData, { ignoreEncryption: true });
        const uploadTasks = [];

        // Definimos un prefijo para los nombres de archivo basado en el Excel (ajusta "Nombre_Archivo" a tu columna)
        const filePrefix = excelMetadata.Nombre_Archivo || idCaratula;

        // 1. PDF Íntegro (Copia completa)
        uploadTasks.push((async () => {
            const pdfCompleto = await PDFDocument.create();
            const indices = Array.from({ length: originalPdf.getPageCount() }, (_, i) => i);
            const copiedPages = await pdfCompleto.copyPages(originalPdf, indices);
            copiedPages.forEach(p => pdfCompleto.addPage(p));

            const bytes = await pdfCompleto.save();
            const nombreCompleto = `FULL_${filePrefix}.pdf`;
            return await saveToDrive(Buffer.from(bytes), nombreCompleto, TENANT_FOLDERS.PDF_COMPLETO_AUTOMATIZACION);
        })());

        // 2. Fragmentos (Bloques detectados)
        bloques.forEach((bloque) => {
            uploadTasks.push((async () => {
                const nuevoPdf = await PDFDocument.create();
                const indices = bloque.files.map(f => f.pageIdx);

                const copiedPages = await nuevoPdf.copyPages(originalPdf, indices);
                copiedPages.forEach(p => nuevoPdf.addPage(p));

                const bytes = await nuevoPdf.save();
                // Nombre: CATEGORIA_IDCARATULA.pdf
                const nombreSegmento = `${bloque.codigoCategoria}_${filePrefix}.pdf`;
                return await saveToDrive(Buffer.from(bytes), nombreSegmento, folderId);
            })());
        });

        const pdfsResult = await Promise.all(uploadTasks);
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        
        console.log(`[SUCCESS] [JOB_FINISHED] Duración: ${duration}s | Archivos subidos: ${pdfsResult.length}`);
        return pdfsResult;

    } catch (err) {
        console.error(`[CRITICAL] [JOB_FAILED] Job ${jobId}: ${err.message}`);
        throw err;
    } finally {
        // Limpieza atómica de archivos locales
        await Promise.all([
            fs.remove(tmpDir).catch(() => {}),
            fs.remove(pdfPath).catch(() => {})
        ]);
        console.log(`[INFO] [CLEANUP] Recursos locales liberados para Job ${jobId}.`);
    }
};