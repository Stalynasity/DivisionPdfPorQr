import Redis from "ioredis";
import { connection } from "../config/redis.js";
import { insertDocumentRowsBatch, batchUpdateSheetRows } from "./excel.service.js";

const redisClient = new Redis(connection);

export const startBatchFlushCycle = () => {
    console.log("--- Sistema de Batching para Excel Iniciado ---");
    
    // 1. CICLO DE INSERCIÓN MASIVA (CADA 60s)
    setInterval(async () => {
        try {
            const keys = await redisClient.keys("excel_buffer:APP-*");
            for (const key of keys) {
                const appName = key.split(":")[1];
                
                const multi = redisClient.multi();
                multi.lrange(key, 0, -1);
                multi.del(key);
                const [rangeResult] = await multi.exec();
                
                const rawRows = rangeResult[1];
                if (rawRows && rawRows.length > 0) {
                    const rowsToInsert = rawRows.map(r => JSON.parse(r));
                    console.log(`[BATCH-APPEND] Enviando ${rowsToInsert.length} filas a ${appName}...`);
                    await insertDocumentRowsBatch(rowsToInsert, appName);
                }
            }
        } catch (error) {
            console.error("ERROR: BATCH_APPEND_FAILED", error.message);
        }
    }, 60000);

    // 2. CICLO DE ACTUALIZACIÓN DE CELDAS (CADA 10s)
    setInterval(async () => {
        try {
            const STATUS_KEY = "excel_status_buffer";
            
            const multi = redisClient.multi();
            multi.lrange(STATUS_KEY, 0, -1);
            multi.del(STATUS_KEY);
            const [rangeResult] = await multi.exec();

            const rawUpdates = rangeResult[1];
            if (rawUpdates && rawUpdates.length > 0) {
                const updates = rawUpdates.map(u => JSON.parse(u));
                
                // AGRUPAR POR COLUMNA: Separamos "Estado_Carga" de "Pdf_Completo"
                const updatesByColumn = updates.reduce((acc, current) => {
                    const colName = current.columnName || "Estado_Carga"; // Por defecto
                    if (!acc[colName]) acc[colName] = [];
                    acc[colName].push(current);
                    return acc;
                }, {});

                // Procesamos cada grupo de columnas con una sola llamada a la API por grupo
                for (const [colName, colUpdates] of Object.entries(updatesByColumn)) {
                    console.log(`[BATCH-UPDATE] Actualizando ${colUpdates.length} celdas en columna [${colName}]...`);
                    await batchUpdateSheetRows(colUpdates, "maestro", colName);
                }
            }
        } catch (error) {
            console.error("ERROR: BATCH_UPDATE_FAILED", error.message);
        }
    }, 10000);
};