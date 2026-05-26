import nodeCron from "node-cron";
import { setMaintenanceRedis, cleanOldRows, cleanAppDriveExcels } from "./excel.service.js"; 
import { splitQueue } from "../jobs/queue.js";
import { backupFile, deepCleanupDrive } from "./drive.service.js";
import dotenv from "dotenv";

dotenv.config();

export const initMaintenanceScheduler = () => {
    console.log("--- Scheduler de Mantenimiento Semanal Inicializado (Domingos 5:00 PM) ---");

    //0 (minuto), 17 (hora 5 PM), * (día), * (mes), 0 (domingo)
    nodeCron.schedule("0 17 * * 0", async () => {
        
        try {
            console.log("\n--- [!] INICIANDO VENTANA DE MANTENIMIENTO SEMANAL ---");

            // Esto detiene el monitor y evita que entren nuevos archivos
            await setMaintenanceRedis(true);

            // 2. DRENADO: Esperar a que los Workers terminen lo que ya está en curso
            const inicioEspera = Date.now();
            const MAX_ESPERA = 30 * 60 * 1000; // 30 minutos máximo

            let counts = await splitQueue.getJobCounts('wait', 'active');
            let pending = counts.wait + counts.active;

            while (pending > 0) {
                if ((Date.now() - inicioEspera) > MAX_ESPERA) {
                    console.warn("[MANTENIMIENTO] Timeout alcanzado. Forzando continuación para no bloquear el sistema.");
                    break;
                }
                
                console.log(`[MANTENIMIENTO] Esperando: ${counts.wait} en cola, ${counts.active} procesándose...`);
                await new Promise(r => setTimeout(r, 15000)); // Esperar 15 seg antes de re-chequear
                
                counts = await splitQueue.getJobCounts('wait', 'active');
                pending = counts.wait + counts.active;
            }

            // 3. SEGURIDAD: Crear Backup en Drive antes de tocar el Excel
            console.log("[MANTENIMIENTO] Creando copia de seguridad del Maestro en Drive...");
            await backupFile(process.env.EXCEL_DIGITALIZACION);
            console.log("[MANTENIMIENTO] Respaldo confirmado con éxito.");

            // 4. LIMPIEZA: Ejecutar el borrado de filas antiguas (>21 días)
            console.log("[MANTENIMIENTO] Iniciando limpieza de registros antiguos en Excel...");
            await cleanOldRows();

            // 5. NUEVO: Limpieza de Excels de archivos_drive (APP1, APP2, APP3)
            console.log("[MANTENIMIENTO] Iniciando limpieza de Excels de Apps...");
            await cleanAppDriveExcels();

            console.log("[MANTENIMIENTO] Iniciando limpieza de caratulas en Drive (>21 días)...");
            const carpetasParaLimpiarCaratula = [
                process.env.CARPETA_CARATULAS_PDF_1,
                process.env.CARPETA_CARATULAS_PDF_2, 
                process.env.CARPETA_CARATULAS_PDF_3,
                process.env.CARPETA_CARATULAS_PDF_4
            ];
            const statsCaratulasDelet = await deepCleanupDrive(carpetasParaLimpiarCaratula, 21);
            
            console.log("[MANTENIMIENTO] Iniciando limpieza de pdf completos en Drive (>30 días)...");
            const carpetasParaLimpiarPDFcompleto = [
                process.env.DOCUMENTOS_COMPLETOS_PROCESADOS_FOLDER_ID,
            ];
            const statsGenPDF = await deepCleanupDrive(carpetasParaLimpiarPDFcompleto, 30);
            
            console.log(`[MANTENIMIENTO] Caratulas de drive Limpia: ${statsCaratulasDelet.archivosBorrados} archivos y ${statsCaratulasDelet.carpetasBorradas} carpetas eliminadas.`);
            console.log(`[MANTENIMIENTO] PDFs completos Limpio: ${statsGenPDF.archivosBorrados} archivos y ${statsGenPDF.carpetasBorradas} carpetas eliminadas.`);

        } catch (err) {
            // Si algo falla (Drive, Redis o Excel), lo capturamos aquí
            console.error("!!! ERROR CRÍTICO EN CICLO MANTENIMIENTO !!!");
            console.error(`DETALLE: ${err.message}`);
        } finally {
            // 5. APERTURA: SIEMPRE reabrimos el sistema al finalizar o fallar
            await setMaintenanceRedis(false);
            console.log("--- [!] MANTENIMIENTO FINALIZADO - SISTEMA REABIERTO ---\n");
        }
    });
};