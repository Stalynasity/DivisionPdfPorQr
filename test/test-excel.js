import { getDataFromExcel, updateSheetRow } from "../src/services/excel.service.js";
import dotenv from "dotenv";

dotenv.config();

async function runTest() {
    const idAProbar = "CAR_0988190060001_CR-LINE_260208011935"; // <--- Cambia esto por un ID real de tu columna A
    
    console.log(`\n--- 🧪 INICIANDO TEST DE EXCEL ---`);
    console.log(`🔍 Buscando ID: ${idAProbar}...`);

    try {
        // 1. Prueba de Lectura
        const data = await getDataFromExcel(idAProbar);

        if (data) {
            console.log("✅ ID ENCONTRADO:");
            console.table(data);

            // 2. Prueba de Escritura
            console.log(`✍️ Intentando actualizar estado en la fila ${data.rowNumber}...`);
            await updateSheetRow(data.rowNumber, "maestro", "ESTADO_CARGA", "TEST_EXITOSO");
            
            console.log("✅ PROCESO COMPLETADO: Revisa tu Google Sheet, la columna 'Estado' debería decir 'TEST_EXITOSO'.");
        } else {
            console.error("❌ El ID no existe en el archivo. Verifica que esté en la columna 'ID_Caratula'.");
        }

    } catch (error) {
        console.error("💥 ERROR DURANTE EL TEST:", error.message);
    }
}

runTest();