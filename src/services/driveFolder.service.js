import { drive } from "./drive.service.js"; // importamos el drive ya inicializado

// Listar archivos en carpeta
export const getFilesInFolder = async (folderId) => {
    const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "files(id, name, mimeType, createdTime)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
    });
    return res.data.files || [];
};

// Mover archivo a otra carpeta
export const moveFileToFolder = async (fileId, targetFolderId) => {
    const file = await drive.files.get({ fileId, fields: "parents", supportsAllDrives: true });
    const previousParents = file.data.parents.join(",");

    await drive.files.update({
        fileId,
        addParents: targetFolderId,
        removeParents: previousParents,
        supportsAllDrives: true
    });
};
