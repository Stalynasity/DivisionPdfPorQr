import fs from "fs-extra";
import { PDFDocument } from "pdf-lib";
import { renderPdfToImages } from "./render.service.js";
import { readQR } from "./qr.service.js";
import { uploadFileToDrive } from "./drive.service.js";
import { TENANT_FOLDERS, PATHS } from "../config/tenants.js";
import pLimit from "p-limit";
import path from "path";
import { updateSheetRow, enqueueStatusUpdate, enqueueDocumentRows, enqueueCellUpdate } from "../services/excel.service.js";

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
        const files = (await fs.readdir(tmpDir)).sort((a, b) => {
            const numA = parseInt(a.match(/\d+/)?.[0] || 0);
            const numB = parseInt(b.match(/\d+/)?.[0] || 0);
            return numA - numB;
        });

        if (!files.length) throw new Error("PDF_EMPTY_OR_RENDER_FAILED");
        console.log(`INFO: SPLIT_RENDER - ${logId} | Pages: ${files.length}`);

        // --- LECTURA QR (PARALELA) ---
        const limit = pLimit(4); // Máximo 4 procesos de OCR simultáneos
        const qrResults = await Promise.all(
            // ELIMINAMOS .slice(1) para incluir la página 1 (índice 0)
            files.map(file => limit(async () => {
                const imgPath = path.join(tmpDir, file);

                // Extrae el número de página del nombre del archivo (ej: page-1.png -> 1)
                const match = file.match(/\d+/);
                const pageIdx = match ? parseInt(match[0]) - 1 : 0;

                let qrData = null;
                try {
                    qrData = await readQR(imgPath);
                    if (qrData) {
                        qrData = qrData.replace(/^"+|"+$/g, "").trim();
                        // Este log te confirmará que ahora sí lee la Página 1
                        console.log(`Página ${pageIdx + 1}: QR Detectado -> ${qrData}`);
                    }
                } catch (err) {
                    console.warn(`WARN: QR_READ_FAIL - ${logId} | Page: ${pageIdx + 1} | Msg: ${err.message}`);
                }
                return { file, qrData, pageIdx };
            }))
        );

        // --- SEGMENTACIÓN POR BLOQUES ---
        const bloques = [];
        let bloqueActual = { codigo: null, indices: [] };

        for (const item of qrResults) {
            if (item.qrData?.startsWith("SEP|")) {
                // Guardar bloque previo si tiene contenido
                if (bloqueActual.codigo && bloqueActual.indices.length > 0) {
                    bloques.push({ ...bloqueActual });
                }
                // Nuevo separador detectado
                bloqueActual.codigo = item.qrData.split("|")[1]?.trim() || "DESCONOCIDO";
                bloqueActual.indices = [];
            } else if (bloqueActual.codigo) {
                // Es página de contenido
                bloqueActual.indices.push(item.pageIdx);
            }
        }

        if (bloqueActual.codigo && bloqueActual.indices.length > 0) bloques.push(bloqueActual);

        // Agregar el último bloque detectado
        if (bloqueActual.length) {
            bloques.push({
                files: bloqueActual,
                codigoCategoria: codigoActual || "DESCONOCIDO"
            });
        }

        if (bloques.length === 0) {
            // Si no hay bloques, significa que no se detectaron separadores QR válidos
            const errorMsg = "DOCUMENTO_SIN_CATEGORIAS: No se detectaron separadores QR (SEP|...) válidos en el archivo.";
            console.warn(`[WARN] ${logId} | ${errorMsg}`);

            // Lanzamos un error específico que el processor pueda identificar
            throw new Error("NO_CATEGORIES_FOUND");
        }

        // --- GENERACIÓN Y CARGA PARALELIZADA ---
        const pdfData = await fs.readFile(pdfPath);
        const originalPdf = await PDFDocument.load(pdfData, { ignoreEncryption: true });


        // Tarea de respaldo: Usamos el buffer original directamente (más rápido)
        const backupTask = (async () => {
            const nameSeguroGen = String(excelMetadata.ID_Caratula).replace(/[\/\\?%*:|"<>]/g, "-");
            const nombreCompleto = `GEN_${nameSeguroGen}_${jobId}.pdf`;

            // 1. Esto se queda igual: Se sube el archivo real a Drive al instante
            const url = await uploadFileToDrive(pdfData, nombreCompleto, TENANT_FOLDERS.PDF_COMPLETO_AUTOMATIZACION);

            // 2. ¡EL AHORRO API! Enviamos el texto al buffer de Redis
            await enqueueCellUpdate(
                excelMetadata.rowNumber,
                "Pdf_Completo",
                "DIGITALIZACION_APP/DOCUMENTOS_COMPLETOS_PROCESADOS/" + nombreCompleto
            );

            return { categoria: "PDF_COMPLETO", url };
        })();

        // Tareas de segmentos: Con límite de 2 para proteger el ancho de banda
        const uploadLimit = pLimit(2);
        const segmentTasks = bloques.map((bloque) => uploadLimit(async () => {
            try {
                const indices = bloque.indices || bloque.files.filter(f => !f.esSeparador).map(f => f.pageIdx);
                if (indices.length === 0) return null;

                const nuevoPdf = await PDFDocument.create();

                // Aseguramos que las páginas se copien correctamente
                const copiedPages = await nuevoPdf.copyPages(originalPdf, indices);
                for (const page of copiedPages) {
                    nuevoPdf.addPage(page);
                }

                // CORRECCIÓN: Sanitización de caracteres para evitar errores de ruta (ENOENT)
                // Esto cambia "Cheque/Gerencia" por "Cheque-Gerencia"
                const idSeguro = String(excelMetadata.ID_Caratula).replace(/[\/\\?%*:|"<>]/g, "-");
                const codigoSeguro = String(bloque.codigo || bloque.codigoCategoria).replace(/[\/\\?%*:|"<>]/g, "-");

                const nombreSegmento = `${codigoSeguro}_${idSeguro}.pdf`;

                // Usamos una configuración de guardado más conservadora
                const bytes = await nuevoPdf.save({
                    useObjectStreams: false,
                    addDefaultFont: false
                });

                const url = await uploadFileToDrive(Buffer.from(bytes), nombreSegmento, targetDriveFolderId);

                return { categoria: bloque.codigo || bloque.codigoCategoria, url, nombre: nombreSegmento };
            } catch (e) {
                // Si falla un segmento, lo logueamos pero no matamos todo el proceso
                console.error(`[ERROR_SEGMENTO] ${logId} | Segmento: ${bloque.codigo} | Msg: ${e.message}`);

                // Si el error es de red, sí lanzamos para reintentar el ticket completo
                const errMsg = e.message.toLowerCase();
                if (errMsg.includes('getaddrinfo') || errMsg.includes('timeout') || errMsg.includes('econnreset')) {
                    throw new Error(`REINTENTO_POR_RED: ${e.message}`);
                }

                return null; // Otros errores omiten el segmento
            }
        }));

        // Ejecutamos todo en paralelo
        const allResults = await Promise.all([backupTask, ...segmentTasks]);

        const validResults = allResults.filter(r => r && r.categoria !== "PDF_COMPLETO");

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

                // await insertDocumentRowsBatch(excelRows, excelMetadata.APP_ASIGNADA);
                await enqueueDocumentRows(excelRows, excelMetadata.APP_ASIGNADA);
            } catch (e) {
                console.error(`ERROR: EXCEL_BATCH_FAILED - ${logId} | Msg: ${e.message}`);
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`INFO: SPLIT_COMPLETED - ${logId} | Duration: ${duration}s`);

        return { idCaratula: excelMetadata.ID_Caratula, jobId, archivos: validResults };

    } catch (err) {
        console.error(`CRITICAL: SPLIT_FATAL - ${logId} | Msg: ${err.message}`);
        // await updateSheetRow(excelMetadata.rowNumber, "maestro", "Estado_Carga", `SPLIT_FATAL - ${logId} | Msg: ${err.message}`);
        await enqueueStatusUpdate(excelMetadata.rowNumber, `SPLIT_FATAL - ${logId} | Msg: ${err.message}`);
        throw err;
    } finally {
        // --- LIMPIEZA DE ARCHIVOS LOCALES ---
        await Promise.all([
            fs.remove(tmpDir).catch(() => { })
        ]);
    }
};