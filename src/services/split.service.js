import fs from "fs-extra";
import { PDFDocument } from "pdf-lib";
import { renderPdfToImages } from "./render.service.js";
import { readQR } from "./qr.service.js";
import { saveToDrive } from "./drive.service.js";
import { TENANT_FOLDERS, PATHS } from "../config/tenants.js";
import pLimit from "p-limit";
import path from "path";
import { updateSheetRow, insertDocumentRowsBatch } from "../services/excel.service.js";

export const processPdfSplit = async (pdfPath, tenant, jobId, targetDriveFolderId, excelMetadata) => {
    const startTime = Date.now();
    const tmpDir = path.join(PATHS.tempImg, `job-${jobId}`);
    const folderId = TENANT_FOLDERS[tenant];
    /** @type {import('../interfaces/excel.interface.js').ExcelMetadata} */
    const DataExcelCaratula = excelMetadata;
    console.table(DataExcelCaratula);

    // Log de inicio con metadata clave
    console.log(`\n🚀 [JOB:${jobId}] >>> INICIANDO PROCESO`);
    console.log(`   | Tenant: ${tenant.toUpperCase()} | ID_Caratula: ${DataExcelCaratula.ID_Caratula}`);
    console.log(`   | Archivo: ${path.basename(pdfPath)}`);

    if (!folderId) {
        console.error(`❌ [JOB:${jobId}] [CONFIG_ERROR] Tenant '${tenant}' no existe en TENANT_FOLDERS.`);
        throw new Error(`Tenant no registrado: ${tenant}`);
    }

    try {
        await fs.ensureDir(tmpDir);
        await fs.emptyDir(tmpDir);

        // --- RENDERIZADO ---
        const renderStart = Date.now();
        await renderPdfToImages(pdfPath, tmpDir);
        const files = (await fs.readdir(tmpDir)).sort();

        if (!files.length) throw new Error("PDF vacío o error en renderizado.");
        console.log(`📸 [JOB:${jobId}] [RENDER] OK: ${files.length} páginas generadas en ${((Date.now() - renderStart) / 1000).toFixed(2)}s`);

        // --- LECTURA QR ---
        console.log(`🔍 [JOB:${jobId}] [QR] Escaneando códigos...`);
        const limit = pLimit(4);
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
                    console.warn(`⚠️ [JOB:${jobId}] [QR_WARN] Pág ${pageIdx + 1}: ${err.message}`);
                }
                return { file, qrData, pageIdx };
            }))
        );

        // --- SEGMENTACIÓN ---
        const bloques = [];
        let bloqueActual = [];
        let codigoActual = null;

        for (const { file, qrData, pageIdx } of qrResults) {
            if (qrData?.startsWith("SEP|")) {
                const nuevoCodigo = qrData.split("|")[1]?.trim() || "UNKNOWN";
                if (bloqueActual.length) {
                    bloques.push({ files: [...bloqueActual], codigoCategoria: codigoActual || "UNKNOWN" });
                }
                bloqueActual = [{ file, pageIdx, esSeparador: true }];
                codigoActual = nuevoCodigo;
                continue;
            }
            bloqueActual.push({ file, pageIdx, esSeparador: false });
        }
        if (bloqueActual.length) bloques.push({ files: bloqueActual, codigoCategoria: codigoActual || "UNKNOWN" });

        console.log(`📦 [JOB:${jobId}] [SEGMENT] Se identificaron ${bloques.length} bloques lógicos.`);

        // --- GENERACIÓN Y CARGA ---
        const pdfData = await fs.readFile(pdfPath);
        const originalPdf = await PDFDocument.load(pdfData, { ignoreEncryption: true });
        const uploadTasks = [];

        // 1. Logica PDF Completo
        uploadTasks.push((async () => {
            try {
                const pdfCompleto = await PDFDocument.create();
                const indices = Array.from({ length: originalPdf.getPageCount() }, (_, i) => i);
                const copiedPages = await pdfCompleto.copyPages(originalPdf, indices);
                copiedPages.forEach(p => pdfCompleto.addPage(p));
                const bytes = await pdfCompleto.save();

                const nombreCompleto = `AUTOMATICO_${DataExcelCaratula.ID_Caratula}.pdf`;
                const url = await saveToDrive(Buffer.from(bytes), nombreCompleto, TENANT_FOLDERS.PDF_COMPLETO_AUTOMATIZACION);

                await updateSheetRow(DataExcelCaratula.rowNumber, "maestro", "Pdf_Completo", "DIGITALIZACION_APP/DOCUMENTOS_COMPLETOS_PROCESADOS/" + nombreCompleto);
                console.log(`✅ [JOB:${jobId}] [UPLOAD] PDF COMPLETO guardado.`);
                return { categoria: "PDF_COMPLETO", url };
            } catch (e) {
                console.error(`❌ [JOB:${jobId}] [FATAL] Error en PDF Completo: ${e.message}`);
                return null;
            }
        })());

        // 2. Logica Segmentos
        const totalBloques = bloques.length;
        bloques.forEach((bloque, index) => {
            uploadTasks.push((async () => {
                try {
                    const nuevoPdf = await PDFDocument.create();
                    const indices = bloque.files.filter(f => !f.esSeparador).map(f => f.pageIdx);

                    if (indices.length === 0) {
                        console.warn(`[JOB:${jobId}] ⚠️ Bloque [${bloque.codigoCategoria}] omitido: No contiene páginas válidas.`);
                        return null;
                    }

                    const copiedPages = await nuevoPdf.copyPages(originalPdf, indices);
                    copiedPages.forEach(p => nuevoPdf.addPage(p));
                    const bytes = await nuevoPdf.save();

                    const nombreSegmento = `${bloque.codigoCategoria}_${DataExcelCaratula.ID_Caratula}.pdf`;

                    console.log(`[JOB:${jobId}] ⬆️ Subiendo [${index + 1}/${totalBloques}]: ${nombreSegmento} (${indices.length} pág)...`);
                    const url = await saveToDrive(Buffer.from(bytes), nombreSegmento, targetDriveFolderId);

                    console.log(`[JOB:${jobId}] ✅ [UPLOAD_OK] Segmento [${bloque.codigoCategoria}] en Drive.`);
                    return { categoria: bloque.codigoCategoria, url };
                } catch (e) {
                    console.error(`[JOB:${jobId}] ❌ [SEGMENT_FAIL] Error en bloque ${bloque.codigoCategoria}: ${e.message}`);
                    return null;
                }
            })());
        });

        const rawResults = await Promise.all(uploadTasks);
        const validResults = rawResults.filter(r => 
            r !== null && r.categoria !== "PDF_COMPLETO"
        );

        // --- REGISTRO EXCEL ---
        const excelRows = validResults.map(res => {
            const fechaAhora = new Date().toISOString().replace('T', ' ').split('.')[0];
            
            // Ya no necesitamos el ternario aquí porque PDF_COMPLETO nunca llegará a este punto
            const nombrePdf = `${res.categoria}_${DataExcelCaratula.ID_Caratula}.pdf`;

            return [
                res.url,
                nombrePdf,
                DataExcelCaratula.ID_Caratula,
                res.categoria,
                DataExcelCaratula.No_Identificacion,
                `https://drive.google.com/file/d/${res.url}/view`,
                fechaAhora
            ];
        });

        if (excelRows.length > 0) {
            try {
                await insertDocumentRowsBatch(excelRows, DataExcelCaratula.APP_ASIGNADA);
                console.log(`[JOB:${jobId}] ✨ [EXCEL_OK] Registros insertados correctamente.`);
            } catch (e) {
                console.error(`[JOB:${jobId}]  [EXCEL_ERROR] Fallo al insertar filas: ${e.message}`);
            }
        }
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`🏁 [JOB:${jobId}] >>> FINITO en ${duration}s\n`);

        return {
            idCaratula: DataExcelCaratula.ID_Caratula,
            jobId,
            archivos: validResults
        };

    } catch (err) {
        console.error(`🚨 [JOB:${jobId}] [CRITICAL_FAIL] Error global: ${err.message}`);
        throw err;
    } finally {
        await Promise.all([
            fs.remove(tmpDir).catch(() => { }),
            fs.remove(pdfPath).catch(() => { })
        ]);
    }
};