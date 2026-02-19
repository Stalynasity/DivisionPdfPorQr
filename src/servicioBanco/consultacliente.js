
export const procesarYConfirmar = (dataRecibida) => {
    try {

        // 1. Lógica de consulta: Verificar si el ID ya existe
        const existe = dataRecibida.cedula === "1234567890"; // Simulación de consulta

        if (existe) {
            console.log("Consulta exitosa: El archivo ya se puede registrar.");
            return true; // Enviamos el true solicitado
        }

        return false; 

    } catch (error) {
        console.error("Error procesando data: " + error);
        return false; 
    }
}