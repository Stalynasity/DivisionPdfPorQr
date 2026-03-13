import axios from 'axios';
import { getDriveClient } from './drive.service.js';

export const sendDocumentToSoap = async (archivo, clienteData) => {
    try {
        const drive = await getDriveClient();
        
        // Descarga del PDF desde Drive
        const response = await drive.files.get({
            fileId: archivo.url,
            alt: 'media',
        }, { responseType: 'arraybuffer' });
        
        const base64Content = Buffer.from(response.data).toString('base64');
        const fileName = `${archivo.categoria}_${clienteData.ID_Caratula}.pdf`;

        // Mapeo dinámico de atributos
        const attributesMap = [
            { id: "IdCaratulaIAM", value: clienteData.ID_Caratula },
            { id: "NoIdentificacion", value: clienteData.No_Identificacion },
            { id: "NombreCliente", value: clienteData.Nombre_cliente }
        ].filter(attr => attr.value);

        const attrXml = attributesMap.map(attr => `
            <urn:item>
               <urn:ID>${attr.id}</urn:ID>
               <urn:Values>
                  <urn:item>
                     <urn:Value>${attr.value}</urn:Value>
                  </urn:item>
               </urn:Values>
            </urn:item>`).join('');

        // Construcción del XML basado en tu captura de SoapUI
        const soapEnvelope = `
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:document">
   <soapenv:Header/>
   <soapenv:Body>
      <urn:newDocument2>
         <urn:CategoryID>${archivo.categoria}</urn:CategoryID>
         <urn:DocumentID>${clienteData.ID_Caratula}</urn:DocumentID>
         <urn:Title>${fileName}</urn:Title>
         <urn:Summary>Carga Automática - ${clienteData.Usuario}</urn:Summary>
         <urn:Date>${new Date().toISOString().split('T')[0]}</urn:Date>
         <urn:Attributes>
            ${attrXml}
         </urn:Attributes>
         <urn:Files>
            <urn:item>
               <urn:Name>${fileName}</urn:Name>
               <urn:Content>${base64Content}</urn:Content>
            </urn:item>
         </urn:Files>
      </urn:newDocument2>
   </soapenv:Body>
</soapenv:Envelope>`;

        // Envío con el Header de Autorización requerido
        return await axios.post(process.env.SOAP_ENDPOINT, soapEnvelope, {
            headers: { 
                'Content-Type': 'text/xml;charset=UTF-8',
                'AUTORIZATION': process.env.SOAP_AUTHORIZATION // Header según tu imagen de SoapUI
            }
        });

    } catch (error) {
        throw new Error(`Error en envío SOAP: ${error.message}`);
    }
};