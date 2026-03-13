import { Worker } from "bullmq";
import { connection } from "../config/redis.js";
import { sendDocumentToSoap } from "../services/soap.service.js";
import fs from "fs-extra";
import path from "path";

const soapProcessor = async (job) => {
    const { jsonPath } = job.data;
    
    // 1. Validar que el archivo JSON existe antes de empezar
    if (!(await fs.pathExists(jsonPath))) {
        console.error(`ERROR: JSON_NOT_FOUND - El archivo ${jsonPath} ya no existe.`);
        return { status: 'skipped', reason: 'file_not_found' };
    }

    const metadata = await fs.readJson(jsonPath);
    const { resultMetadata, clienteData } = metadata;
    const logId = `SOAP_JOB:${job.id} | ID:${resultMetadata.idCaratula}`;

    console.log(`INFO: START_PROCESS - ${logId}`);

    const results = [];
    let successCount = 0;

    // 2. Iterar por cada documento generado en el proceso de split
    for (const archivo of resultMetadata.archivos) {
        try {
            console.log(`DEBUG: UPLOADING_TO_SOAP - ${logId} | Categoria: ${archivo.categoria}`);
            
            // Llamada al servicio SOAP con la data del cliente y el archivo de Drive
            const response = await sendDocumentToSoap(archivo, clienteData);
            
            results.push({ categoria: archivo.categoria, status: 'ok', response: response?.data });
            successCount++;
        } catch (err) {
            console.error(`ERROR: SOAP_STEP_FAILED - ${logId} | Cat: ${archivo.categoria} | Msg: ${err.message}`);
            results.push({ categoria: archivo.categoria, status: 'failed', error: err.message });
            // Nota: No lanzamos error aquí para permitir que los demás archivos de la lista se procesen
        }
    }

    // 3. Gestión de archivos físicos (Movimiento a carpeta de éxito o error)
    const baseDir = path.dirname(jsonPath);
    const fileName = path.basename(jsonPath);
    
    // Determinamos la carpeta de destino según el resultado
    const folderName = successCount === resultMetadata.archivos.length ? 'procesados_soap' : 'con_errores_soap';
    const targetDir = path.join(baseDir, folderName);
    const destinationPath = path.join(targetDir, fileName);

    try {
        await fs.ensureDir(targetDir);
        await fs.move(jsonPath, destinationPath, { overwrite: true });
        console.log(`INFO: JSON_MOVED - ${logId} -> ${folderName}`);
    } catch (moveErr) {
        console.error(`CRITICAL: MOVE_FAILED - No se pudo mover el JSON: ${moveErr.message}`);
    }

    // 4. Resultado final del Job
    if (successCount === 0 && resultMetadata.archivos.length > 0) {
        throw new Error(`SOAP_TOTAL_FAILURE: Ningún archivo pudo ser enviado para ${resultMetadata.idCaratula}`);
    }

    return { 
        status: successCount === resultMetadata.archivos.length ? 'success' : 'partial_success', 
        processed: successCount, 
        total: resultMetadata.archivos.length,
        details: results 
    };
};

// Configuración del Worker
const soapWorker = new Worker("soapQueue", soapProcessor, {
    connection,
    concurrency: 2, // Procesar 2 JSONs simultáneamente
    lockDuration: 60000, // 1 minuto de bloqueo
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 }
});

// Eventos de monitoreo
soapWorker.on('completed', (job) => {
    console.log(`INFO: SOAP_JOB_FINISHED - Ticket: ${job.id} | Status: ${job.returnvalue.status}`);
});

soapWorker.on('failed', (job, err) => {
    console.error(`CRITICAL: SOAP_JOB_FAILED - Ticket: ${job?.id} | Error: ${err.message}`);
});

export default soapWorker;