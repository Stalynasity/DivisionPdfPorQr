import { getOrCreateFolderPath, saveToDrive } from "../src/services/drive.service.js";
import { getDataFromExcel } from "../src/services/excel.service.js";
import dotenv from "dotenv";

dotenv.config();

const testFolderLogic = async () => {
    // Reemplaza con un ID de carpeta real de tu Drive para la prueba
    const ROOT_FOLDER_ID = process.env.ID_CARPETA_DIGITALIZADOS || "ID_DE_PRUEBA_AQUÍ";
    const idAProbar = "CAR_12321321_PRUEBA_TOTAL_260307061407";

/** @type {import('../src/interfaces/excel.interface.js').ExcelMetadata} */
    const mockMetadata = await getDataFromExcel(idAProbar);
    console.log("-data de id caratula---");
    console.table(mockMetadata);

    console.log("--- 🧪 INICIANDO TEST DE ESTRUCTURA DE DRIVE ---");

    try {
        console.log(`1. Creando/Verificando ruta: ${mockMetadata.usuario}/${mockMetadata.identificacion}/${mockMetadata.proceso}`);

        const targetId = await getOrCreateFolderPath(ROOT_FOLDER_ID, [
            mockMetadata.Usuario,
            mockMetadata.No_Identificacion,
            mockMetadata.Proceso
        ]);

        console.log(`✅ ID de carpeta destino obtenido: ${targetId}`);

        // 2. Intentar subir un archivo de prueba pequeño
        console.log("2. Subiendo archivo de prueba...");
        const mockBuffer = Buffer.from("Este es un PDF de prueba");
        const fileId = await saveToDrive(mockBuffer, "TEST_ARCHIVO.pdf", targetId);

        console.log(`🚀 TEST EXITOSO. Archivo subido con ID: ${fileId}`);
        console.log(`🔗 Revisa tu Drive en: https://drive.google.com/drive/folders/${targetId}`);

    } catch (error) {
        console.error("❌ EL TEST FALLÓ:", error.message);
    }
};

testFolderLogic();