import nodeCron from "node-cron";
import { setMaintenanceMode } from "./monitor.service.js";
import { splitQueue } from "../jobs/queue.js";
import { cleanOldRows } from "./excel.service.js";

export const initMaintenanceScheduler = () => {
    console.log("--- Scheduler de Mantenimiento Mensual Inicializado ---");

    // Se ejecuta cada Domingo a las 00:00
    nodeCron.schedule("0 0 * * 0", async () => {
        const hoy = new Date();
        const ultimoDomingo = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
        ultimoDomingo.setDate(ultimoDomingo.getDate() - ultimoDomingo.getDay());

        // Validar si hoy es el último domingo del mes
        if (hoy.getDate() === ultimoDomingo.getDate()) {
            try {
                console.log("--- INICIANDO VENTANA DE MANTENIMIENTO ---");
                
                // 1. Pausar entrada de nuevos archivos
                setMaintenanceMode(true);

                // 2. Esperar a que los workers terminen lo que tienen activo
                let counts = await splitQueue.getJobCounts('wait', 'active');
                let pending = counts.wait + counts.active;

                while (pending > 0) {
                    console.log(`[MANTENIMIENTO] Esperando ${pending} trabajos pendientes...`);
                    await new Promise(r => setTimeout(r, 10000)); // Esperar 10 seg
                    counts = await splitQueue.getJobCounts('wait', 'active');
                    pending = counts.wait + counts.active;
                }

                // 3. Ejecutar la limpieza de 21 días
                console.log("[MANTENIMIENTO] Cola vacía. Limpiando Excel...");
                await cleanOldRows();

                // 4. Reabrir el sistema
                setMaintenanceMode(false);
                console.log("--- MANTENIMIENTO FINALIZADO CON ÉXITO ---");

            } catch (err) {
                console.error("ERROR EN MANTENIMIENTO:", err.message);
                setMaintenanceMode(false); // Reabrir por seguridad si algo falla
            }
        }
    });
};