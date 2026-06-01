import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readBarcodes, prepareZXingModule, purgeZXingModule } from "zxing-wasm/reader";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(__dirname, "zxing_reader.wasm");

const OPCIONES_LECTURA = {
    tryInvert: true,
    formats:   ["QRCode"],
    isPure:    false,
};

// Indica si el motor WASM ya fue inicializado
let motorListo = false;

// ─── Helpers privados ─────────────────────────────────────────────────────────

const inicializarMotor = async () => {
    await prepareZXingModule({
        overrides: { wasmBinary: fs.readFileSync(WASM_PATH), noInitialRun: true },
        fireImmediately: true,
    });
    motorListo = true;
};

/**
 * Detecta si un error es un crash de memoria WASM.
 * ZXing puede lanzar excepciones C++ con mensajes como "excptr" o "allocate".
 */
const esCrashDeMemoria = (msg) =>
    ["excptr", "undefined", "allocate", "memory"].some((k) => msg.includes(k));

const reiniciarMotor = () => {
    motorListo = false;
    try { purgeZXingModule(); } catch { /* si purge falla, la próxima llamada re-inicializa */ }
    console.error("[QR] Crash de memoria WASM — motor reiniciado para la próxima lectura.");
};

// ─── Función principal ────────────────────────────────────────────────────────

/**
 * Lee el primer código QR de una imagen usando ZXing WASM de forma local.
 * Se auto-recupera si el motor de WASM falla por memoria.
 *
 * @param {string} rutaImagen - Ruta absoluta a la imagen
 * @returns {Promise<string|null>} Texto del QR, o null si no se detectó
 */
export const leerQR = async (rutaImagen) => {
    if (!fs.existsSync(rutaImagen)) return null;

    try {
        if (!motorListo) await inicializarMotor();

        const resultados = await readBarcodes(fs.readFileSync(rutaImagen), OPCIONES_LECTURA);

        if (resultados?.length) {
            console.log(`[QR] Detectado: ${resultados[0].text}`);
            return resultados[0].text;
        }

        return null;

    } catch (err) {
        if (esCrashDeMemoria(err.message.toLowerCase())) {
            reiniciarMotor();
        } else {
            console.error(`[QR] Error inesperado: ${err.message}`);
        }
        return null;
    }
};