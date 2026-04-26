import { setMaintenanceRedis, cleanOldRows, cleanAppDriveExcels } from "../src/services/excel.service.js"; 
import { splitQueue } from "../src/jobs/queue.js";
import { backupFile, deepCleanupDrive } from "../src/services/drive.service.js";
import dotenv from "dotenv";

dotenv.config();

async function runFullMaintenanceSimulation() {
    const startTest = Date.now();
    console.log("\n🚀 === INICIANDO SIMULACIÓN DE MANTENIMIENTO COMPLETO ===\n");

    try {
        // --- PASO 1: BLOQUEO ---
        console.log("Step 1: Activando modo mantenimiento en Redis...");
        await setMaintenanceRedis(true);
        console.log("✅ Sistema bloqueado. (Verifica que el monitor no procese nada ahora)");

        // --- PASO 2: DRENADO ---
        console.log("\nStep 2: Iniciando drenado de colas (Draining)...");
        const MAX_ESPERA = 2 * 60 * 1000; // 2 min para el test
        const inicioEspera = Date.now();

        let counts = await splitQueue.getJobCounts('wait', 'active');
        let pending = counts.wait + counts.active;

        while (pending > 0) {
            if ((Date.now() - inicioEspera) > MAX_ESPERA) {
                console.warn("⚠️ Timeout de drenado (Simulado).");
                break;
            }
            console.log(`⏳ Pendientes: ${pending} (Espera 10s...)`);
            await new Promise(r => setTimeout(r, 10000));
            counts = await splitQueue.getJobCounts('wait', 'active');
            pending = counts.wait + counts.active;
        }
        console.log("✅ Drenado completado o bajo control.");

        // --- PASO 3: BACKUP ---
        // console.log("\nStep 3: Ejecutando Backup del Excel Maestro en Drive...");
        // const backupId = await backupFile(process.env.EXCEL_DIGITALIZACION);
        // console.log(`✅ Backup generado con éxito. ID: ${backupId}`);

        // // --- PASO 4: LIMPIEZA EXCEL ---
        // console.log("\nStep 4: Limpieza de filas antiguas en Excel Maestro (>21 días)...");
        // await cleanOldRows();
        // console.log("✅ Limpieza de registros maestros finalizada.");

        // console.log("\nStep 5: Limpieza de Excels secundarios (Apps)...");
        // await cleanAppDriveExcels();
        // console.log("✅ Excels de apps saneados.");

        // --- PASO 6: DRIVE DEEP CLEANUP ---
        console.log("\nStep 6: Ejecutando limpieza profunda de carpetas Drive (>21 días)...");
        const carpetasParaLimpiar = [
            process.env.CARPETA_CARATULAS_PDF_1,
            process.env.CARPETA_CARATULAS_PDF_2,
            process.env.CARPETA_CARATULAS_PDF_3,
            process.env.CARPETA_CARATULAS_PDF_4
        ].filter(Boolean);

        const statsDrive = await deepCleanupDrive(carpetasParaLimpiar, 21);
        console.log(`✅ DRIVE LIMPIO: ${statsDrive.archivosBorrados} archivos y ${statsDrive.carpetasBorradas} carpetas eliminadas.`);

    } catch (err) {
        console.error("\n❌ ERROR DURANTE LA SIMULACIÓN:");
        console.error(err.message);
    } finally {
        // --- PASO 7: REAPERTURA ---
        console.log("\nStep 7: Reabriendo el sistema...");
        await setMaintenanceRedis(false);
        const duracionTotal = ((Date.now() - startTest) / 1000).toFixed(2);
        console.log(`\n🏁 === TEST FINALIZADO EN ${duracionTotal}s ===`);
        console.log("INFO: El monitor debería retomar el trabajo ahora.\n");
        process.exit(0);
    }
}

runFullMaintenanceSimulation();