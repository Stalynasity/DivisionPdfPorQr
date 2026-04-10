import dotenv from "dotenv";
dotenv.config();
import { setMaintenanceRedis, cleanOldRows, cleanAppDriveExcels } from "../src/services/excel.service.js";
import { backupFile } from "../src/services/drive.service.js";

async function runTest() {
    console.log("--- INICIANDO PRUEBA DE MANTENIMIENTO ---");
    try {
        // 1. Bloqueo
        await setMaintenanceRedis(true);
        console.log("1. Sistema bloqueado en Redis.");

        // 2. Backup
        console.log("2. Iniciando Backup...");
        // const backupId = await backupFile(process.env.EXCEL_DIGITALIZACION);
        // console.log(`Backup creado con éxito. ID: ${backupId}`);

        // 3. Limpieza
        console.log("3. Iniciando limpieza...");
        // await cleanOldRows();
        console.log("Limpieza completada.");

        // 5. NUEVO: Limpieza de Excels de archivos_drive (APP1, APP2, APP3)
        console.log("[MANTENIMIENTO] Iniciando limpieza de Excels de archivos_drive...");
        await cleanAppDriveExcels();

    } catch (error) {
        console.error("FALLO EN LA PRUEBA:", error);
    } finally {
        // 4. Desbloqueo
        await setMaintenanceRedis(false);
        console.log("4. Sistema desbloqueado. Prueba finalizada.");
        process.exit(0);
    }
}

runTest();