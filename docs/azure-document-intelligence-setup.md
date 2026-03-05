# Azure Document Intelligence Setup (Production)

Last verified in codebase: 2026-03-05.

This app already contains the Azure client integration in:
- `src/ai/azure-ai.ts` (`getDocumentClient`, OCR extraction pipeline)
- `src/ai/config/azure-runtime.ts` (env resolution)
- `src/app/api/infralith/azure/doc-intel/route.ts` (runtime health + probe API)

## 1) Create Azure Document Intelligence resource

Use Azure Portal:
1. Create resource -> search `Document Intelligence`.
2. Pricing tier: `S0` for production.
3. Region: same/near your App Service region.
4. After deploy, copy:
   - `Endpoint`
   - `Key 1` (or `Key 2`)

Or Azure CLI:

```bash
az login
az account set --subscription "<SUBSCRIPTION_ID>"
az group create --name "<RG_NAME>" --location "<LOCATION>"
az cognitiveservices account create \
  --name "<DOC_INTEL_NAME>" \
  --resource-group "<RG_NAME>" \
  --kind FormRecognizer \
  --sku S0 \
  --location "<LOCATION>" \
  --yes
```

Fetch endpoint/key:

```bash
az cognitiveservices account show \
  --name "<DOC_INTEL_NAME>" \
  --resource-group "<RG_NAME>" \
  --query "properties.endpoint" -o tsv

az cognitiveservices account keys list \
  --name "<DOC_INTEL_NAME>" \
  --resource-group "<RG_NAME>" \
  --query "key1" -o tsv
```

## 2) Configure app environment

Set these env vars in `.env.local` (local) and App Service Configuration (production):

```bash
AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=https://<your-doc-intel-name>.cognitiveservices.azure.com/
AZURE_DOCUMENT_INTELLIGENCE_KEY=<your-key>
```

Supported legacy aliases (optional):
- `AZURE_FORM_RECOGNIZER_ENDPOINT`
- `AZURE_FORM_RECOGNIZER_KEY`

## 3) Verify connection from this project

### A. Status check (credentials format + initialization)

`GET /api/infralith/azure/doc-intel`

Success response includes:
- runtime summary
- `docIntel.configured=true`

### B. Live probe (real analyze call)

`POST /api/infralith/azure/doc-intel`

Payload:

```json
{
  "sampleDocumentUrl": "https://<public-file-url>/sample-plan.pdf",
  "timeoutMs": 20000
}
```

Notes:
- `sampleDocumentUrl` must be publicly reachable by Azure service.
- If probe fails, response includes `docIntel.error` for troubleshooting.
