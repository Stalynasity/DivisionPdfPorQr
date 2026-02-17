import dotenv from "dotenv";
import { getDataFromExcel } from "./src/services/excel.service.js";

dotenv.config();

async function testExcel() {
    // Reemplaza esto con un ID que sepas que existe en tu columna ID_Caratula
    const idAProbar = "CAR_1111111111_TAR-JET_260213111444"; 

    console.log("=== TEST DE LECTURA EXCEL ===");
    console.log(`Buscando ID: ${idAProbar}`);
    console.log(`Usando SPREADSHEET_ID: ${process.env.EXCEL_DATABASE_ID}`);
    console.log("------------------------------");

    try {
        const resultado = await getDataFromExcel(idAProbar);

        if (resultado) {
            console.log("Se encontraron los datos:");
            console.table(resultado); // Muestra los datos en una tabla bonita
        } else {
            console.log("Conexión exitosa, pero el ID no se encontró en el archivo.");
        }
    } catch (error) {
        console.error("ERROR EN EL TEST:");
        console.error(error.message);
        
        if (error.message.includes("403")) {
            console.error("confirma que es un problema de PERMISOS. o en drive.file agregar mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'");
        }
    }
}

testExcel();