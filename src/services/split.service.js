import fs from "fs-extra";
import { PDFDocument } from "pdf-lib";
import { renderPdfToImages } from "./render.service.js";
import { readQR } from "./qr.service.js";
import { saveToDrive } from "./drive.service.js";
import { TENANT_FOLDERS, PATHS } from "../config/tenants.js";
import pLimit from "p-limit";
import path from "path";
import { updateSheetRow, insertDocumentRowsBatch } from "../services/excel.service.js";

/**
 * Procesa la división de un PDF local basándose en separadores QR.
 * @param {string} pdfPath - Ruta absoluta del archivo PDF en el sistema local.
 * @param {string} jobId - ID del ticket/trabajo para logs y carpetas temporales.
 * @param {string} targetDriveFolderId - ID de la carpeta de Drive donde se guardarán los segmentos.
 * @param {object} excelMetadata - Datos del registro maestro de Excel.
 */
export const processPdfSplit = async (pdfPath, jobId, targetDriveFolderId, excelMetadata) => {
    const startTime = Date.now();
    const tmpDir = path.join(PATHS.tempImg, `job-${jobId}`);
    const logId = `JOB:${jobId}`;

    try {
        // --- VALIDACIÓN INICIAL ---
        if (!(await fs.pathExists(pdfPath))) {
            throw new Error(`ARCHIVO_NO_ENCONTRADO: La ruta ${pdfPath} no existe.`);
        }

        await fs.ensureDir(tmpDir);
        await fs.emptyDir(tmpDir);

        // --- RENDERIZADO ---
        // Convierte cada página del PDF en imagen para lectura de QR
        await renderPdfToImages(pdfPath, tmpDir);
        const files = (await fs.readdir(tmpDir)).sort();

        if (!files.length) throw new Error("PDF_EMPTY_OR_RENDER_FAILED");
        console.log(`INFO: SPLIT_RENDER - ${logId} | Pages: ${files.length}`);

        // --- LECTURA QR (PARALELA) ---
        const limit = pLimit(4); // Máximo 4 procesos de OCR simultáneos
        const qrResults = await Promise.all(
            files.slice(1).map(file => limit(async () => {
                const imgPath = path.join(tmpDir, file);
                // Extrae el número de página del nombre del archivo (ej: page-1.png -> 0)
                const pageIdx = parseInt(file.match(/\d+/)[0]) - 1;
                let qrData = null;
                try {
                    qrData = await readQR(imgPath);
                    if (qrData) qrData = qrData.replace(/^"+|"+$/g, "").trim();
                } catch (err) {
                    console.warn(`WARN: QR_READ_FAIL - ${logId} | Page: ${pageIdx + 1} | Msg: ${err.message}`);
                }
                return { file, qrData, pageIdx };
            }))
        );

        // --- SEGMENTACIÓN POR BLOQUES ---
        const bloques = [];
        let bloqueActual = [];
        let codigoActual = null;

        for (const { file, qrData, pageIdx } of qrResults) {
            // Si detecta el patrón "SEP|CODIGO", inicia un nuevo bloque
            if (qrData?.startsWith("SEP|")) {
                const nuevoCodigo = qrData.split("|")[1]?.trim() || "UNKNOWN";
                if (bloqueActual.length) {
                    bloques.push({
                        files: [...bloqueActual],
                        codigoCategoria: codigoActual || "UNKNOWN"
                    });
                }
                bloqueActual = [{ file, pageIdx, esSeparador: true }];
                codigoActual = nuevoCodigo;
                continue;
            }
            bloqueActual.push({ file, pageIdx, esSeparador: false });
        }

        // Agregar el último bloque detectado
        if (bloqueActual.length) {
            bloques.push({
                files: bloqueActual,
                codigoCategoria: codigoActual || "UNKNOWN"
            });
        }

        // --- GENERACIÓN DE PDFs Y CARGA A DRIVE ---
        const pdfData = await fs.readFile(pdfPath);
        const originalPdf = await PDFDocument.load(pdfData, { ignoreEncryption: true });
        const uploadTasks = [];

        // 1. Generar y Guardar PDF Completo (Respaldo)
        uploadTasks.push((async () => {
            try {
                const pdfCompleto = await PDFDocument.create();
                const indices = Array.from({ length: originalPdf.getPageCount() }, (_, i) => i);
                const copiedPages = await pdfCompleto.copyPages(originalPdf, indices);
                copiedPages.forEach(p => pdfCompleto.addPage(p));
                const bytes = await pdfCompleto.save();

                const nombreCompleto = `AUTOMATICO_${excelMetadata.ID_Caratula}.pdf`;
                await saveToDrive(Buffer.from(bytes), nombreCompleto, TENANT_FOLDERS.PDF_COMPLETO_AUTOMATIZACION);

                await updateSheetRow(
                    excelMetadata.rowNumber,
                    "maestro",
                    "Pdf_Completo",
                    "DIGITALIZACION_APP/DOCUMENTOS_COMPLETOS_PROCESADOS/" + nombreCompleto
                );

                return { categoria: "PDF_COMPLETO" };
            } catch (e) {
                console.error(`ERROR: FULL_PDF_FAILED - ${logId} | Msg: ${e.message}`);
                return null;
            }
        })());

        // 2. Generar y Guardar Segmentos Individuales
        bloques.forEach((bloque) => {
            uploadTasks.push((async () => {
                try {
                    const nuevoPdf = await PDFDocument.create();
                    // Filtramos para no incluir la página del separador QR en el PDF final
                    const indices = bloque.files.filter(f => !f.esSeparador).map(f => f.pageIdx);
                    if (indices.length === 0) return null;

                    const copiedPages = await nuevoPdf.copyPages(originalPdf, indices);
                    copiedPages.forEach(p => nuevoPdf.addPage(p));
                    const bytes = await nuevoPdf.save();

                    const nombreSegmento = `${bloque.codigoCategoria}_${excelMetadata.ID_Caratula}.pdf`;
                    const url = await saveToDrive(Buffer.from(bytes), nombreSegmento, targetDriveFolderId);

                    return { categoria: bloque.codigoCategoria, url };
                } catch (e) {
                    console.error(`ERROR: BLOCK_FAILED - ${logId} | Category: ${bloque.codigoCategoria} | Msg: ${e.message}`);
                    return null;
                }
            })());
        });

        const rawResults = await Promise.all(uploadTasks);
        const validResults = rawResults.filter(r => r !== null && r.categoria !== "PDF_COMPLETO");

        // --- REGISTRO BATCH EN EXCEL ---
        if (validResults.length > 0) {
            try {
                const fechaAhora = new Date().toISOString().replace('T', ' ').split('.')[0];
                const excelRows = validResults.map(res => [
                    res.url,                                      // ID Drive
                    `${res.categoria}_${excelMetadata.ID_Caratula}.pdf`, // Nombre
                    excelMetadata.ID_Caratula,                    // Relación
                    res.categoria,                                // Tipo
                    excelMetadata.No_Identificacion,              // Cédula/RUC
                    `https://drive.google.com/file/d/${res.url}/view`, // Link
                    fechaAhora                                    // Fecha
                ]);

                await insertDocumentRowsBatch(excelRows, excelMetadata.APP_ASIGNADA);
            } catch (e) {
                console.error(`ERROR: EXCEL_BATCH_FAILED - ${logId} | Msg: ${e.message}`);
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`INFO: SPLIT_COMPLETED - ${logId} | Duration: ${duration}s`);

        return { idCaratula: excelMetadata.ID_Caratula, jobId, archivos: validResults };

    } catch (err) {
        console.error(`CRITICAL: SPLIT_FATAL - ${logId} | Msg: ${err.message}`);
        throw err;
    } finally {
        // --- LIMPIEZA DE ARCHIVOS LOCALES ---
        await Promise.all([
            fs.remove(tmpDir).catch(() => { })
        ]);
    }
};